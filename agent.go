package main

import (
	"bufio"
	"crypto/tls"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ---------- آمار ترافیک ----------
type agentStats struct {
	mu sync.Mutex
	m  map[int]*tunStat
}
type tunStat struct{ in, out, conn atomic.Int64 }

func newAgentStats() *agentStats { return &agentStats{m: map[int]*tunStat{}} }
func (a *agentStats) get(id int) *tunStat {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m[id] == nil {
		a.m[id] = &tunStat{}
	}
	return a.m[id]
}
func (a *agentStats) drain() []map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []map[string]any{}
	for id, s := range a.m {
		i, o, c := s.in.Swap(0), s.out.Swap(0), s.conn.Swap(0)
		if i != 0 || o != 0 || c != 0 {
			out = append(out, map[string]any{"tunnel_id": id, "bytes_in": i, "bytes_out": o, "connections": c, "running": true})
		}
	}
	return out
}

var stats = newAgentStats()
var lastSelfUpdateTry time.Time

// ---------- منابع سیستم (CPU/RAM/Disk) از /proc ----------
var cpuPrev struct {
	sync.Mutex
	total, idle uint64
}

func readCPU() (total, idle uint64) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		f := strings.Fields(line)
		for i, v := range f[1:] {
			n, _ := strconv.ParseUint(v, 10, 64)
			total += n
			if i == 3 || i == 4 { // idle + iowait
				idle += n
			}
		}
		return total, idle
	}
	return 0, 0
}

func cpuPercent() float64 {
	total, idle := readCPU()
	cpuPrev.Lock()
	defer cpuPrev.Unlock()
	if cpuPrev.total == 0 || total <= cpuPrev.total {
		cpuPrev.total, cpuPrev.idle = total, idle
		return 0
	}
	dt := float64(total - cpuPrev.total)
	di := float64(idle - cpuPrev.idle)
	cpuPrev.total, cpuPrev.idle = total, idle
	if dt <= 0 {
		return 0
	}
	pct := (1 - di/dt) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct
}

func collectResources() map[string]any {
	out := map[string]any{"cpu_percent": cpuPercent(), "num_cpu": runtime.NumCPU()}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		var total, avail int64
		for _, line := range strings.Split(string(raw), "\n") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				kb, _ := strconv.ParseInt(f[1], 10, 64)
				switch f[0] {
				case "MemTotal:":
					total = kb * 1024
				case "MemAvailable:":
					avail = kb * 1024
				}
			}
		}
		out["mem_total_bytes"] = total
		out["mem_used_bytes"] = total - avail
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs("/", &st); err == nil {
		total := int64(st.Blocks) * int64(st.Bsize)
		free := int64(st.Bavail) * int64(st.Bsize)
		out["disk_total_bytes"] = total
		out["disk_used_bytes"] = total - free
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		f := strings.Fields(string(raw))
		if len(f) > 0 {
			out["load1"], _ = strconv.ParseFloat(f[0], 64)
		}
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		f := strings.Fields(string(raw))
		if len(f) > 0 {
			sec, _ := strconv.ParseFloat(f[0], 64)
			out["uptime_seconds"] = int64(sec)
		}
	}
	return out
}

func copyCount(dst net.Conn, src net.Conn, counter *atomic.Int64) {
	buf := make([]byte, 65536)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			counter.Add(int64(n))
			if _, werr := dst.Write(buf[:n]); werr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	if cw, ok := dst.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
	}
}

// ---------- کانفیگ دریافتی از پنل ----------
type listenCfg struct {
	ID            int    `json:"id"`
	Type          string `json:"type"`
	Protocol      string `json:"protocol"`
	Transport     string `json:"transport"`
	ListenPort    int    `json:"listen_port"`
	TargetHost    string `json:"target_host"`
	TargetPort    int    `json:"target_port"`
	Token         string `json:"token"`
	DestRelayHost string `json:"dest_relay_host"`
	DestRelayPort int    `json:"dest_relay_port"`
}
type revCfg struct {
	ID         int    `json:"id"`
	Token      string `json:"token"`
	Transport  string `json:"transport"`
	RelayHost  string `json:"relay_host"`
	RelayPort  int    `json:"relay_port"`
	TargetHost string `json:"target_host"`
	TargetPort int    `json:"target_port"`
}
type acceptCfg struct {
	ID         int    `json:"id"`
	Token      string `json:"token"`
	Transport  string `json:"transport"`
	TargetHost string `json:"target_host"`
	TargetPort int    `json:"target_port"`
}
type agentConfig struct {
	Listen         []listenCfg `json:"listen"`
	ReverseConnect []revCfg    `json:"reverse_connect"`
	AcceptDirect   []acceptCfg `json:"accept_direct"`
	RelayPort      int         `json:"relay_port"`
	SelfUpdate     bool        `json:"self_update"`
}

// ---------- Reverse: هاب سمت سرور عمومی ----------
type pooledConn struct {
	conn   net.Conn
	reader *bufio.Reader
}
type relayHub struct {
	mu            sync.Mutex
	tokens        map[int]string
	directTokens  map[int]string
	directTargets map[int]acceptCfg
	pools         map[int]chan pooledConn
	muxSessions   map[int][]*muxSession
	cert          tls.Certificate
	hasCert       bool
	stats         *agentStats
}

func newRelayHub(stats *agentStats) *relayHub {
	return &relayHub{tokens: map[int]string{}, directTokens: map[int]string{},
		directTargets: map[int]acceptCfg{}, pools: map[int]chan pooledConn{},
		muxSessions: map[int][]*muxSession{}, stats: stats}
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.r.Read(b) }

func (h *relayHub) addMuxSession(s *muxSession) {
	h.mu.Lock()
	h.muxSessions[s.tunnelID] = append(h.muxSessions[s.tunnelID], s)
	h.mu.Unlock()
	s.onClose = func(x *muxSession) {
		h.mu.Lock()
		lst := h.muxSessions[x.tunnelID]
		for i, it := range lst {
			if it == x {
				h.muxSessions[x.tunnelID] = append(lst[:i], lst[i+1:]...)
				break
			}
		}
		h.mu.Unlock()
	}
}

func (h *relayHub) getMuxSession(tid int, want string) *muxSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	var best *muxSession
	for _, s := range h.muxSessions[tid] {
		if s.closed.Load() {
			continue
		}
		if want != "" && want != "auto" && s.transport != want {
			continue
		}
		if best == nil || s.StreamsCount() < best.StreamsCount() {
			best = s
		}
	}
	return best
}

func targetDial(host string, port int) (net.Conn, error) {
	return net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 10*time.Second)
}

type relayInit struct {
	Type      string `json:"type"`
	Mode      string `json:"mode"`
	Transport string `json:"transport"`
	TunnelID  int    `json:"tunnel_id"`
	Token     string `json:"token"`
}
func (h *relayHub) pool(id int) chan pooledConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pools[id] == nil {
		h.pools[id] = make(chan pooledConn, 64)
	}
	return h.pools[id]
}
func (h *relayHub) handleAgent(conn net.Conn) {
	// تشخیص پروتکل روی یک پورت: TLS (0x16) | WebSocket (GET) | JSON خام
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	reader := bufio.NewReader(conn)
	peek, err := reader.Peek(1)
	if err != nil {
		return
	}
	if peek[0] == 0x16 && h.hasCert {
		tlsConn := tls.Server(&bufferedConn{Conn: conn, r: reader}, &tls.Config{Certificates: []tls.Certificate{h.cert}})
		if err := tlsConn.Handshake(); err != nil {
			return
		}
		conn = tlsConn
		reader = bufio.NewReader(conn)
		peek, err = reader.Peek(1)
		if err != nil {
			return
		}
	}
	bc := &bufferedConn{Conn: conn, r: reader}
	if peek[0] == 'G' {
		ws, err := wsServerHandshake(conn, reader)
		if err != nil {
			return
		}
		raw, err := ws.Recv()
		if err != nil {
			return
		}
		var init relayInit
		if json.Unmarshal(raw, &init) != nil {
			return
		}
		h.handleWSInit(ws, init)
		return
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return
	}
	var init relayInit
	if json.Unmarshal([]byte(line), &init) != nil {
		return
	}
	h.handleRawInit(bc, reader, init)
}

func (h *relayHub) authToken(table map[int]string, init relayInit) bool {
	h.mu.Lock()
	tok, ok := table[init.TunnelID]
	h.mu.Unlock()
	return ok && tok == init.Token
}

func (h *relayHub) handleRawInit(bc *bufferedConn, reader *bufio.Reader, init relayInit) {
	switch init.Type {
	case "register", "": // "" سازگاری با ثبت قدیمی ورکر Reverse
		if !h.authToken(h.tokens, init) {
			fmt.Printf("[relay] auth failed from %s\n", bc.RemoteAddr())
			_ = bc.Close()
			return
		}
		_ = bc.SetReadDeadline(time.Time{})
		if init.Mode == "mux" {
			sess := newMuxSession(&rawTransport{conn: bc, reader: reader}, normTransport(init.Transport), init.TunnelID, true, targetDial)
			h.addMuxSession(sess)
			sess.Run()
			return
		}
		select {
		case h.pool(init.TunnelID) <- pooledConn{bc, reader}:
		default:
			_ = bc.Close()
		}
	case "connect": // Direct TCP: ورودی مستقیم به خروجی وصل شده
		if !h.authToken(h.directTokens, init) {
			_ = bc.Close()
			return
		}
		h.mu.Lock()
		tgt := h.directTargets[init.TunnelID]
		h.mu.Unlock()
		_ = bc.SetReadDeadline(time.Time{})
		local, err := targetDial(tgt.TargetHost, tgt.TargetPort)
		if err != nil {
			_ = bc.Close()
			return
		}
		defer local.Close()
		defer bc.Close()
		go pipeCounted(local, bc, nil)
		pipeCounted(bc, local, nil)
	case "mux": // Direct Mux: سشن مالتی‌پلکس از سمت ورودی
		if !h.authToken(h.directTokens, init) {
			_ = bc.Close()
			return
		}
		_ = bc.SetReadDeadline(time.Time{})
		sess := newMuxSession(&rawTransport{conn: bc, reader: reader}, normTransport(init.Transport), init.TunnelID, true, targetDial)
		sess.Run()
	}
}

func (h *relayHub) handleWSInit(ws *wsTransport, init relayInit) {
	switch init.Type {
	case "register":
		if !h.authToken(h.tokens, init) || init.Mode != "mux" {
			_ = ws.Close()
			return
		}
		_ = ws.conn.SetReadDeadline(time.Time{})
		sess := newMuxSession(ws, normTransport(init.Transport), init.TunnelID, true, targetDial)
		h.addMuxSession(sess)
		sess.Run()
	case "mux":
		if !h.authToken(h.directTokens, init) {
			_ = ws.Close()
			return
		}
		_ = ws.conn.SetReadDeadline(time.Time{})
		sess := newMuxSession(ws, normTransport(init.Transport), init.TunnelID, true, targetDial)
		sess.Run()
	case "connect":
		if !h.authToken(h.directTokens, init) {
			_ = ws.Close()
			return
		}
		h.mu.Lock()
		tgt := h.directTargets[init.TunnelID]
		h.mu.Unlock()
		_ = ws.conn.SetReadDeadline(time.Time{})
		local, err := targetDial(tgt.TargetHost, tgt.TargetPort)
		if err != nil {
			_ = ws.Close()
			return
		}
		defer local.Close()
		defer ws.Close()
		go func() {
			for {
				raw, err := ws.Recv()
				if err != nil {
					return
				}
				if _, err := local.Write(raw); err != nil {
					return
				}
			}
		}()
		buf := make([]byte, 16384)
		for {
			n, err := local.Read(buf)
			if n > 0 {
				if ws.Send(buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
}

func (h *relayHub) serveRelay(ctx context.Context, port int) {
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		fmt.Printf("[relay] listen :%d failed: %v\n", port, err)
		return
	}
	go func() { <-ctx.Done(); _ = ln.Close() }()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go h.handleAgent(c)
	}
}

func (h *relayHub) getConn(id int, timeout time.Duration) (pooledConn, bool) {
	select {
	case pc := <-h.pool(id):
		return pc, true
	case <-time.After(timeout):
		return pooledConn{}, false
	}
}

// ---------- سرویس‌های یک دور کانفیگ ----------
type serviceSet struct {
	hub    *relayHub
	mu     sync.Mutex
	outMux map[int]*muxSession
}

func (set *serviceSet) getOutMuxSession(t listenCfg) *muxSession {
	set.mu.Lock()
	defer set.mu.Unlock()
	if set.outMux == nil {
		set.outMux = map[int]*muxSession{}
	}
	if s, ok := set.outMux[t.ID]; ok && !s.closed.Load() {
		return s
	}
	tr := normTransport(t.Transport)
	addr := net.JoinHostPort(t.DestRelayHost, strconv.Itoa(t.DestRelayPort))
	init, _ := json.Marshal(map[string]any{"type": "mux", "transport": tr, "tunnel_id": t.ID, "token": t.Token})
	ft, err := dialLink(addr, tr, init)
	if err != nil {
		fmt.Printf("[tunnel %d] dial exit failed: %v\n", t.ID, err)
		return nil
	}
	sess := newMuxSession(ft, tr, t.ID, false, nil)
	set.outMux[t.ID] = sess
	sess.onClose = func(x *muxSession) {
		set.mu.Lock()
		if set.outMux[t.ID] == x {
			delete(set.outMux, t.ID)
		}
		set.mu.Unlock()
	}
	go sess.Run()
	return sess
}

// برقراری لینک بین دو سرور با ترنسپورت انتخابی؛ init اولین پیام لینک است
func dialLink(addr, transport string, init []byte) (frameTransport, error) {
	switch transport {
	case "ws":
		conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
		if err != nil {
			return nil, err
		}
		ws, err := wsClientHandshake(conn, addr, "/tunnel")
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		if err := ws.Send(init); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return ws, nil
	case "wss":
		host, _, _ := net.SplitHostPort(addr)
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", addr,
			&tls.Config{InsecureSkipVerify: true, ServerName: host}) // #nosec: توکن داخل لینک احراز می‌کند
		if err != nil {
			return nil, err
		}
		ws, err := wsClientHandshake(conn, addr, "/tunnel")
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		if err := ws.Send(init); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return ws, nil
	default: // tcpmux و tcp خام
		conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
		if err != nil {
			return nil, err
		}
		if _, err := conn.Write(append(init, '\n')); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return &rawTransport{conn: conn, reader: conn}, nil
	}
}

func pipeCounted(dst net.Conn, src io.Reader, counter *atomic.Int64) {
	buf := make([]byte, 65536)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if counter != nil {
				counter.Add(int64(n))
			}
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func runServices(ctx context.Context, cfg agentConfig) {
	hub := newRelayHub(stats)
	if cert, err := selfSignedCert(); err == nil {
		hub.cert, hub.hasCert = cert, true
	}
	for _, t := range cfg.Listen {
		if t.Type == "reverse" {
			hub.tokens[t.ID] = t.Token
		}
	}
	for _, a := range cfg.AcceptDirect {
		hub.directTokens[a.ID] = a.Token
		hub.directTargets[a.ID] = a
	}
	set := &serviceSet{hub: hub}
	// رله همیشه روی relayPort این نود بالا می‌آید (اگر سرور عمومی باشیم استفاده می‌شود)
	relayPort := cfg.RelayPort
	if relayPort == 0 {
		relayPort = 10000
	}
	go hub.serveRelay(ctx, relayPort)

	var wg sync.WaitGroup
	for _, t := range cfg.Listen {
		t := t
		wg.Add(1)
		go func() {
			defer wg.Done()
			if t.Type == "reverse" {
				serveReverseListener(ctx, hub, t)
			} else {
				if t.Protocol == "tcp" || t.Protocol == "both" {
					serveForwardTCP(ctx, set, t)
				}
				if t.Protocol == "udp" || t.Protocol == "both" {
					serveForwardUDP(ctx, t)
				}
			}
		}()
	}
	for _, rc := range cfg.ReverseConnect {
		rc := rc
		tr := normTransport(rc.Transport)
		spawnTCP := func(n int) {
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); reverseWorker(ctx, rc) }()
			}
		}
		spawnMux := func(transport string, n int) {
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); reverseMuxWorker(ctx, rc, transport) }()
			}
		}
		switch tr {
		case "tcpmux", "ws", "wss":
			spawnMux(tr, 3)
		case "auto":
			spawnTCP(3)
			spawnMux("tcpmux", 1)
			spawnMux("ws", 1)
			spawnMux("wss", 1)
		default:
			spawnTCP(5)
		}
	}
	<-ctx.Done()
	wg.Wait()
}

func serveForwardTCP(ctx context.Context, set *serviceSet, t listenCfg) {
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", t.ListenPort))
	if err != nil {
		fmt.Printf("[tunnel %d] listen :%d failed: %v\n", t.ID, t.ListenPort, err)
		return
	}
	go func() { <-ctx.Done(); _ = ln.Close() }()
	fmt.Printf("[+] forward tunnel %d listening :%d -> %s:%d\n", t.ID, t.ListenPort, t.TargetHost, t.TargetPort)
	st := stats.get(t.ID)
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func(client net.Conn) {
			if t.DestRelayHost != "" {
				tr := normTransport(t.Transport)
				if tr != "tcp" {
					sess := set.getOutMuxSession(t)
					if sess == nil {
						_ = client.Close()
						return
					}
					if err := sess.Open(client, t.TargetHost, t.TargetPort, st); err != nil {
						_ = client.Close()
					}
					return
				}
				defer client.Close()
				up, err := net.DialTimeout("tcp", net.JoinHostPort(t.DestRelayHost, strconv.Itoa(t.DestRelayPort)), 10*time.Second)
				if err != nil {
					return
				}
				defer up.Close()
				hello, _ := json.Marshal(map[string]any{"type": "connect", "tunnel_id": t.ID, "token": t.Token})
				if _, err := up.Write(append(hello, '\n')); err != nil {
					return
				}
				st.conn.Add(1)
				go pipeCounted(up, client, &st.in)
				pipeCounted(client, up, &st.out)
				return
			}
			defer client.Close()
			up, err := net.DialTimeout("tcp", net.JoinHostPort(t.TargetHost, strconv.Itoa(t.TargetPort)), 10*time.Second)
			if err != nil {
				return
			}
			defer up.Close()
			st.conn.Add(1)
			go pipeCounted(up, client, &st.in)
			pipeCounted(client, up, &st.out)
		}(c)
	}
}

func serveReverseListener(ctx context.Context, hub *relayHub, t listenCfg) {
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", t.ListenPort))
	if err != nil {
		fmt.Printf("[tunnel %d] listen :%d failed: %v\n", t.ID, t.ListenPort, err)
		return
	}
	go func() { <-ctx.Done(); _ = ln.Close() }()
	fmt.Printf("[+] reverse tunnel %d listening :%d -> via agent -> %s:%d\n", t.ID, t.ListenPort, t.TargetHost, t.TargetPort)
	st := stats.get(t.ID)
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func(client net.Conn) {
			tr := normTransport(t.Transport)
			if tr != "tcp" {
				if sess := hub.getMuxSession(t.ID, tr); sess != nil {
					if err := sess.Open(client, t.TargetHost, t.TargetPort, st); err != nil {
						_ = client.Close()
					}
					return
				}
				if tr != "auto" {
					_ = client.Close()
					return
				}
			}
			defer client.Close()
			pc, ok := hub.getConn(t.ID, 6*time.Second)
			if !ok {
				fmt.Printf("[tunnel %d] no idle agent connection\n", t.ID)
				return
			}
			defer pc.conn.Close()
			hello, _ := json.Marshal(map[string]any{"target_host": t.TargetHost, "target_port": t.TargetPort})
			if _, err := pc.conn.Write(append(hello, '\n')); err != nil {
				return
			}
			st.conn.Add(1)
			go pipeCounted(pc.conn, client, &st.in)
			pipeCounted(client, pc.reader, &st.out)
		}(c)
	}
}

func reverseWorker(ctx context.Context, rc revCfg) {
	addr := net.JoinHostPort(rc.RelayHost, strconv.Itoa(rc.RelayPort))
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
		if err != nil {
			sleepCtx(ctx, 5*time.Second)
			continue
		}
		func() {
			defer conn.Close()
			reg, _ := json.Marshal(map[string]any{"tunnel_id": rc.ID, "token": rc.Token})
			if _, err := conn.Write(append(reg, '\n')); err != nil {
				return
			}
			reader := bufio.NewReader(conn)
			line, err := reader.ReadString('\n')
			if err != nil {
				sleepCtx(ctx, 2*time.Second)
				return
			}
			var cmd struct {
				TargetHost string `json:"target_host"`
				TargetPort int    `json:"target_port"`
			}
			if json.Unmarshal([]byte(line), &cmd) != nil {
				return
			}
			local, err := net.DialTimeout("tcp", net.JoinHostPort(cmd.TargetHost, strconv.Itoa(cmd.TargetPort)), 10*time.Second)
			if err != nil {
				fmt.Printf("[reverse %d] local connect %s:%d failed: %v\n", rc.ID, cmd.TargetHost, cmd.TargetPort, err)
				return
			}
			defer local.Close()
			go pipeCounted(conn, local, nil)
			pipeCounted(local, reader, nil)
		}()
	}
}

// ورکر Reverse برای ترنسپورت‌های مالتی‌پلکس: یک سشن دائمی با چند استریم
func reverseMuxWorker(ctx context.Context, rc revCfg, transport string) {
	addr := net.JoinHostPort(rc.RelayHost, strconv.Itoa(rc.RelayPort))
	dialLocal := func(string, int) (net.Conn, error) {
		return targetDial(rc.TargetHost, rc.TargetPort)
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		init, _ := json.Marshal(map[string]any{"type": "register", "mode": "mux", "transport": transport,
			"tunnel_id": rc.ID, "token": rc.Token})
		ft, err := dialLink(addr, transport, init)
		if err != nil {
			sleepCtx(ctx, 4*time.Second)
			continue
		}
		sess := newMuxSession(ft, transport, rc.ID, true, dialLocal)
		done := make(chan struct{})
		go func() { sess.Run(); close(done) }()
		select {
		case <-ctx.Done():
			sess.Close()
			return
		case <-done:
		}
		sleepCtx(ctx, 2*time.Second)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// ---------- Forward UDP ----------
type udpSession struct {
	conn     *net.UDPConn
	lastSeen atomic.Int64
}

func serveForwardUDP(ctx context.Context, t listenCfg) {
	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("0.0.0.0:%d", t.ListenPort))
	if err != nil {
		return
	}
	pc, err := net.ListenUDP("udp", addr)
	if err != nil {
		fmt.Printf("[tunnel %d] udp listen :%d failed: %v\n", t.ID, t.ListenPort, err)
		return
	}
	go func() { <-ctx.Done(); _ = pc.Close() }()
	fmt.Printf("[+] forward UDP tunnel %d listening :%d -> %s:%d\n", t.ID, t.ListenPort, t.TargetHost, t.TargetPort)
	st := stats.get(t.ID)
	sessions := map[string]*udpSession{}
	var mu sync.Mutex
	buf := make([]byte, 65535)
	for {
		n, clientAddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			return
		}
		data := append([]byte(nil), buf[:n]...)
		st.in.Add(int64(n))
		key := clientAddr.String()
		mu.Lock()
		sess := sessions[key]
		if sess == nil {
			upAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(t.TargetHost, strconv.Itoa(t.TargetPort)))
			if err != nil {
				mu.Unlock()
				continue
			}
			up, err := net.DialUDP("udp", nil, upAddr)
			if err != nil {
				mu.Unlock()
				continue
			}
			sess = &udpSession{conn: up}
			sessions[key] = sess
			st.conn.Add(1)
			go func(s *udpSession, ca *net.UDPAddr) {
				b := make([]byte, 65535)
				for {
					m, err := s.conn.Read(b)
					if err != nil {
						return
					}
					st.out.Add(int64(m))
					_, _ = pc.WriteToUDP(b[:m], ca)
				}
			}(sess, clientAddr)
		}
		sess.lastSeen.Store(time.Now().Unix())
		mu.Unlock()
		_, _ = sess.conn.Write(data)
	}
}

// ---------- حلقه اصلی ایجنت ----------
type panelClient struct {
	base  string
	token string
	hc    *http.Client
}

func (c *panelClient) call(method, path string, body any) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Node-Token", c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return raw, fmt.Errorf("panel returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func localIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if a, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return a.IP.String()
	}
	return ""
}

func runAgent(panelURL, token string, relayPort, pollSec int) error {
	if panelURL == "" || token == "" {
		return fmt.Errorf("agent needs --panel and --token")
	}
	client := &panelClient{base: strings.TrimRight(panelURL, "/"), token: token, hc: &http.Client{Timeout: 15 * time.Second}}
	hostname, _ := os.Hostname()
	info := map[string]any{"hostname": hostname, "ip": localIP(), "version": Version,
		"os_info": runtime.GOOS + " " + runtime.GOARCH + " / " + hostname, "relay_port": relayPort}

	for {
		if _, err := client.call("POST", "/api/agent/register", info); err == nil {
			break
		} else {
			fmt.Printf("[!] register failed (%v); retry in 5s\n", err)
			time.Sleep(5 * time.Second)
		}
	}
	fmt.Printf("[*] Tunnel agent v%s connected to %s (relay :%d)\n", Version, panelURL, relayPort)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var currentSig string
	var stopServices context.CancelFunc

	for {
		raw, err := client.call("GET", "/api/agent/config", nil)
		if err != nil {
			fmt.Printf("[!] config fetch failed: %v\n", err)
		} else {
			var cfg agentConfig
			if json.Unmarshal(raw, &cfg) == nil {
				// آپدیت خودکار ایجنت از خود پنل (اگر نسخه پنل تازه‌تر باشد)
				if cfg.SelfUpdate && time.Since(lastSelfUpdateTry) > 10*time.Minute {
					lastSelfUpdateTry = time.Now()
					fmt.Println("[update] panel has a newer version; updating agent...")
					if nv, err := performSelfUpdate([]string{client.base + "/tpanel"}); err == nil {
						fmt.Printf("[update] agent updated to %s; restarting...\n", nv)
						go func() { time.Sleep(500 * time.Millisecond); reExec() }()
					} else {
						fmt.Println("[update] agent self-update failed:", err)
					}
				}
				if cfg.RelayPort == 0 {
					cfg.RelayPort = relayPort
				}
				sigRaw, _ := json.Marshal(cfg)
				if string(sigRaw) != currentSig {
					currentSig = string(sigRaw)
					if stopServices != nil {
						stopServices()
						time.Sleep(300 * time.Millisecond)
					}
					sctx, scancel := context.WithCancel(ctx)
					stopServices = scancel
					go runServices(sctx, cfg)
				}
			}
			hb := map[string]any{"hostname": hostname, "ip": localIP(), "version": Version,
				"os_info": info["os_info"], "relay_port": relayPort, "stats": stats.drain()}
			for k, v := range collectResources() {
				hb[k] = v
			}
			if _, err := client.call("POST", "/api/agent/heartbeat", hb); err != nil {
				fmt.Printf("[!] heartbeat failed: %v\n", err)
			}
		}
		time.Sleep(time.Duration(maxInt(pollSec, 3)) * time.Second)
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
