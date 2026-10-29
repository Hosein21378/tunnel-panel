package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------- فریم مالتی‌پلکس ----------
// هدر ۹ بایتی: streamID(4) + type(1) + len(4)، بعد payload
const (
	frameOpen    = 1
	frameOpenOK  = 2
	frameOpenErr = 3
	frameData    = 4
	frameClose   = 5
	framePing    = 6
	framePong    = 7
)

type muxFrame struct {
	ID      uint32
	Type    byte
	Payload []byte
}

func encodeFrame(f muxFrame) []byte {
	buf := make([]byte, 9+len(f.Payload))
	binary.BigEndian.PutUint32(buf[0:4], f.ID)
	buf[4] = f.Type
	binary.BigEndian.PutUint32(buf[5:9], uint32(len(f.Payload)))
	copy(buf[9:], f.Payload)
	return buf
}

func decodeFrame(raw []byte) (muxFrame, error) {
	if len(raw) < 9 {
		return muxFrame{}, fmt.Errorf("short frame")
	}
	n := binary.BigEndian.Uint32(raw[5:9])
	if int(n) != len(raw)-9 {
		return muxFrame{}, fmt.Errorf("bad frame length")
	}
	return muxFrame{ID: binary.BigEndian.Uint32(raw[0:4]), Type: raw[4], Payload: raw[9:]}, nil
}

// ترنسپورت فریم: روی TCP خام (هدر طولی) یا روی WebSocket (هر فریم یک پیام)
type frameTransport interface {
	Send([]byte) error
	Recv() ([]byte, error)
	Close() error
}

type rawTransport struct {
	conn   net.Conn
	reader io.Reader
	wmu    sync.Mutex
}

func (t *rawTransport) Send(b []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	_, err := t.conn.Write(b)
	return err
}
func (t *rawTransport) Recv() ([]byte, error) {
	head := make([]byte, 9)
	if _, err := io.ReadFull(t.reader, head); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(head[5:9])
	if n > 16*1024*1024 {
		return nil, fmt.Errorf("frame too large")
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(t.reader, payload); err != nil {
		return nil, err
	}
	return append(head, payload...), nil
}
func (t *rawTransport) Close() error { return t.conn.Close() }

// ---------- WebSocket حداقلی (RFC6455) ----------
func wsAcceptKey(key string) string {
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h[:])
}

type wsTransport struct {
	conn       net.Conn
	reader     *bufio.Reader
	wmu        sync.Mutex
	maskedSend bool
}

func (t *wsTransport) Send(payload []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	return wsWriteFrame(t.conn, 0x2, payload, t.maskedSend)
}
func (t *wsTransport) Recv() ([]byte, error) {
	for {
		op, payload, err := wsReadFrame(t.reader)
		if err != nil {
			return nil, err
		}
		switch op {
		case 0x2, 0x1: // binary / text
			return payload, nil
		case 0x9: // ping -> pong
			t.wmu.Lock()
			_ = wsWriteFrame(t.conn, 0xA, payload, false)
			t.wmu.Unlock()
		case 0x8:
			return nil, io.EOF
		}
	}
}
func (t *wsTransport) Close() error { return t.conn.Close() }

func wsWriteFrame(w io.Writer, op byte, payload []byte, masked bool) error {
	var head []byte
	head = append(head, 0x80|op)
	n := len(payload)
	var maskBit byte
	if masked {
		maskBit = 0x80
	}
	switch {
	case n < 126:
		head = append(head, maskBit|byte(n))
	case n < 65536:
		head = append(head, maskBit|126, byte(n>>8), byte(n))
	default:
		head = append(head, maskBit|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		head = append(head, b[:]...)
	}
	if _, err := w.Write(head); err != nil {
		return err
	}
	if masked {
		mask := make([]byte, 4)
		_, _ = rand.Read(mask)
		if _, err := w.Write(mask); err != nil {
			return err
		}
		maskedPayload := make([]byte, n)
		for i := range payload {
			maskedPayload[i] = payload[i] ^ mask[i%4]
		}
		_, err := w.Write(maskedPayload)
		return err
	}
	_, err := w.Write(payload)
	return err
}

func wsReadFrame(r *bufio.Reader) (byte, []byte, error) {
	b1, err := r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	b2, err := r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	op := b1 & 0x0F
	masked := b2&0x80 != 0
	n := uint64(b2 & 0x7F)
	if n == 126 {
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	} else if n == 127 {
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > 16*1024*1024 {
		return 0, nil, fmt.Errorf("ws frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return op, payload, nil
}

// هندشیک سمت سرور: روی reader بافردار انجام می‌شود و کانکشن WS برمی‌گردد
func wsServerHandshake(conn net.Conn, reader *bufio.Reader) (*wsTransport, error) {
	var key string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "sec-websocket-key:") {
			key = strings.TrimSpace(line[len("sec-websocket-key:"):])
		}
	}
	if key == "" {
		return nil, fmt.Errorf("no websocket key")
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n\r\n"
	if _, err := conn.Write([]byte(resp)); err != nil {
		return nil, err
	}
	return &wsTransport{conn: conn, reader: reader}, nil
}

// هندشیک سمت کلاینت
func wsClientHandshake(conn net.Conn, host, path string) (*wsTransport, error) {
	keyBytes := make([]byte, 16)
	_, _ = rand.Read(keyBytes)
	key := base64.StdEncoding.EncodeToString(keyBytes)
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, host, key)
	if _, err := conn.Write([]byte(req)); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if !strings.Contains(status, "101") {
		return nil, fmt.Errorf("websocket upgrade refused: %s", strings.TrimSpace(status))
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if strings.TrimRight(line, "\r\n") == "" {
			break
		}
	}
	return &wsTransport{conn: conn, reader: reader, maskedSend: true}, nil
}

// ---------- گواهی self-signed برای WSS ----------
func selfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "tpanel"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"tpanel"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// ---------- سشن مالتی‌پلکس ----------
type muxStream struct {
	conn   net.Conn
	respCh chan bool
	onIn   func(int)
	onOut  func(int)
}

type muxSession struct {
	tr        frameTransport
	transport string
	tunnelID  int
	isExit    bool
	dialLocal func(host string, port int) (net.Conn, error)
	streams   sync.Map // uint32 -> *muxStream
	pending   sync.Map // uint32 -> *muxStream
	nextID    atomic.Uint32
	wmu       sync.Mutex
	closed    atomic.Bool
	onClose   func(*muxSession)
	rttMs     atomic.Int64
}

func newMuxSession(tr frameTransport, transport string, tunnelID int, isExit bool,
	dialLocal func(string, int) (net.Conn, error)) *muxSession {
	return &muxSession{tr: tr, transport: transport, tunnelID: tunnelID, isExit: isExit, dialLocal: dialLocal}
}

func (s *muxSession) send(f muxFrame) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.tr.Send(encodeFrame(f))
}

func (s *muxSession) StreamsCount() int {
	n := 0
	s.streams.Range(func(_, _ any) bool { n++; return true })
	return n
}

func (s *muxSession) Close() {
	if s.closed.Swap(true) {
		return
	}
	_ = s.tr.Close()
	s.streams.Range(func(_, v any) bool {
		v.(*muxStream).conn.Close()
		return true
	})
	if s.onClose != nil {
		s.onClose(s)
	}
}

// StartPinger: مالک سشن (سازنده) هر ۸ ثانیه پینگ می‌فرستد تا RTT لینک معلوم باشد
func (s *muxSession) StartPinger() {
	go func() {
		tk := time.NewTicker(8 * time.Second)
		defer tk.Stop()
		for range tk.C {
			if s.closed.Load() {
				return
			}
			var b [8]byte
			binary.BigEndian.PutUint64(b[:], uint64(time.Now().UnixNano()))
			if err := s.send(muxFrame{ID: 0, Type: framePing, Payload: b[:]}); err != nil {
				return
			}
		}
	}()
}

// اجرای حلقه خواندن فریم‌ها (در گوروتین جدا صدا زده شود)
func (s *muxSession) Run() {
	defer s.Close()
	for {
		raw, err := s.tr.Recv()
		if err != nil {
			return
		}
		f, err := decodeFrame(raw)
		if err != nil {
			continue
		}
		switch f.Type {
		case frameOpen:
			if !s.isExit || s.dialLocal == nil {
				_ = s.send(muxFrame{ID: f.ID, Type: frameOpenErr})
				continue
			}
			var tgt struct {
				Host string `json:"host"`
				Port int    `json:"port"`
			}
			_ = json.Unmarshal(f.Payload, &tgt)
			local, err := s.dialLocal(tgt.Host, tgt.Port)
			if err != nil {
				_ = s.send(muxFrame{ID: f.ID, Type: frameOpenErr})
				continue
			}
			st := &muxStream{conn: local}
			s.streams.Store(f.ID, st)
			_ = s.send(muxFrame{ID: f.ID, Type: frameOpenOK})
			go s.pumpToFrames(f.ID, local, nil)
		case frameOpenOK, frameOpenErr:
			if v, ok := s.pending.LoadAndDelete(f.ID); ok {
				v.(*muxStream).respCh <- f.Type == frameOpenOK
			}
		case frameData:
			if v, ok := s.streams.Load(f.ID); ok {
				st := v.(*muxStream)
				if st.onOut != nil {
					st.onOut(len(f.Payload))
				}
				if _, err := st.conn.Write(f.Payload); err != nil {
					s.closeStream(f.ID)
				}
			}
		case frameClose:
			s.closeStream(f.ID)
		case framePing:
			_ = s.send(muxFrame{ID: 0, Type: framePong, Payload: f.Payload})
		case framePong:
			if len(f.Payload) == 8 {
				sent := int64(binary.BigEndian.Uint64(f.Payload))
				rtt := (time.Now().UnixNano() - sent) / 1e6
				if rtt >= 0 && rtt < 60000 {
					s.rttMs.Store(rtt)
				}
			}
		}
	}
}

func (s *muxSession) closeStream(id uint32) {
	if v, ok := s.streams.LoadAndDelete(id); ok {
		v.(*muxStream).conn.Close()
		_ = s.send(muxFrame{ID: id, Type: frameClose})
	}
}

// pumpToFrames: از کانکشن لوکال می‌خواند و فریم داده می‌فرستد
func (s *muxSession) pumpToFrames(id uint32, conn net.Conn, onIn func(int)) {
	buf := make([]byte, 16384)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			if onIn != nil {
				onIn(n)
			}
			if serr := s.send(muxFrame{ID: id, Type: frameData, Payload: append([]byte(nil), buf[:n]...)}); serr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	s.closeStream(id)
}

// سمت ورودی: باز کردن استریم برای یک کانکشن کاربر
func (s *muxSession) Open(client net.Conn, host string, port int, st *tunStat) error {
	if s.closed.Load() {
		return fmt.Errorf("session closed")
	}
	id := s.nextID.Add(2) // فرد/زوج مهم نیست، یکتا کافی است
	stream := &muxStream{conn: client, respCh: make(chan bool, 1),
		onOut: func(n int) { st.out.Add(int64(n)) }}
	s.pending.Store(id, stream)
	payload, _ := json.Marshal(map[string]any{"host": host, "port": port})
	if err := s.send(muxFrame{ID: id, Type: frameOpen, Payload: payload}); err != nil {
		s.pending.Delete(id)
		return err
	}
	select {
	case ok := <-stream.respCh:
		if !ok {
			return fmt.Errorf("exit refused the connection")
		}
	case <-time.After(10 * time.Second):
		s.pending.Delete(id)
		return fmt.Errorf("open stream timeout")
	}
	s.streams.Store(id, stream)
	st.conn.Add(1)
	go s.pumpToFrames(id, client, func(n int) { st.in.Add(int64(n)) })
	return nil
}

