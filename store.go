package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------- مدل‌های داده (ذخیره JSON روی دیسک - بدون دیتابیس خارجی) ----------

type User struct {
	ID           int    `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
	Role         string `json:"role"` // admin | user
	IsActive     bool   `json:"is_active"`
	CreatedAt    string `json:"created_at"`
}

type Node struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	Host         string `json:"host"`
	ReportedIP   string `json:"reported_ip"`
	ObservedIP   string `json:"observed_ip"`
	Token        string `json:"token"`
	Description  string `json:"description"`
	AgentVersion string `json:"agent_version"`
	OSInfo       string `json:"os_info"`
	RelayPort    int    `json:"relay_port"`
	LastSeen     string `json:"last_seen"`
	CreatedBy    int    `json:"created_by"`
	CreatedAt    string `json:"created_at"`
	// منابع لحظه‌ای (گزارش ایجنت)
	CPUPercent     float64 `json:"cpu_percent"`
	MemUsedBytes   int64   `json:"mem_used_bytes"`
	MemTotalBytes  int64   `json:"mem_total_bytes"`
	DiskUsedBytes  int64   `json:"disk_used_bytes"`
	DiskTotalBytes int64   `json:"disk_total_bytes"`
	Load1          float64 `json:"load1"`
	UptimeSeconds  int64   `json:"uptime_seconds"`
	NumCPU         int     `json:"num_cpu"`
	// گزارش زنده لینک تونل‌ها (از هارت‌بیت ایجنت)
	Links []LinkReport `json:"links"`
}

// LinkReport گزارش یک ایجنت از وضعیت لینک یک تونل (سمت ورودی یا خروجی)
type LinkReport struct {
	TunnelID   int           `json:"tunnel_id"`
	Side       string        `json:"side"` // entry | exit
	Listener   bool          `json:"listener"`
	Transports []TransReport `json:"transports"`
	At         string        `json:"at"`
}

// TransReport وضعیت یک ترنسپورت در لینک بین دو سرور
type TransReport struct {
	Name     string `json:"name"`
	Up       bool   `json:"up"`
	RTTms    int64  `json:"rtt_ms"`
	Streams  int    `json:"streams"`
	Pooled   int    `json:"pooled"`
	Listening bool  `json:"listening"`
	OnDemand bool   `json:"ondemand"`
}

// PortMap یک نگاشت پورت: روی ورودی Listen باز می‌شود و به پورت Target روی خروجی می‌رسد
type PortMap struct {
	Listen int `json:"listen"`
	Target int `json:"target"`
}

type Tunnel struct {
	ID                int    `json:"id"`
	Name              string `json:"name"`
	Type              string `json:"type"` // forward | reverse
	Protocol          string `json:"protocol"`
	SourceNodeID      int    `json:"source_node_id"`
	DestNodeID        int    `json:"dest_node_id"`
	ListenPort        int    `json:"listen_port"`
	TargetHost        string `json:"target_host"`
	TargetPort        int    `json:"target_port"`
	Transport         string `json:"transport"`
	Profile           string    `json:"profile"`
	Ports             []PortMap `json:"ports"`
	Token             string `json:"token"`
	Enabled           bool   `json:"enabled"`
	BytesIn           int64  `json:"bytes_in"`
	BytesOut          int64  `json:"bytes_out"`
	Connections       int64  `json:"connections"`
	TrafficLimitBytes int64  `json:"traffic_limit_bytes"` // 0 = نامحدود
	ExpiresAt         string `json:"expires_at"`
	OwnerID           int    `json:"owner_id"`
	CreatedAt         string `json:"created_at"`
}

type Snapshot struct {
	TunnelID    int   `json:"tunnel_id"`
	TS          int64 `json:"ts"` // unix
	BytesIn     int64 `json:"bytes_in"`
	BytesOut    int64 `json:"bytes_out"`
	Connections int64 `json:"connections"`
}

type Data struct {
	Secret     string     `json:"secret"`
	NextUserID int        `json:"next_user_id"`
	NextNodeID int        `json:"next_node_id"`
	NextTunID  int        `json:"next_tunnel_id"`
	Users      []User     `json:"users"`
	Nodes      []Node     `json:"nodes"`
	Tunnels    []Tunnel   `json:"tunnels"`
	Snapshots  []Snapshot `json:"snapshots"`
}

type Store struct {
	mu   sync.Mutex
	path string
	d    Data
}

func nowStr() string { return time.Now().UTC().Format(time.RFC3339) }

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// هش رمز: salt تصادفی + صدوبیست هزار بار SHA256 (فقط کتابخانه استاندارد)
func hashPassword(pw string) string {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	h := sha256.Sum256(append(salt, []byte(pw)...))
	for i := 0; i < 120000; i++ {
		h = sha256.Sum256(append(h[:], salt...))
	}
	return hex.EncodeToString(salt) + "$" + hex.EncodeToString(h[:])
}

func verifyPassword(pw, stored string) bool {
	parts := strings.SplitN(stored, "$", 2)
	if len(parts) != 2 {
		return false
	}
	salt, _ := hex.DecodeString(parts[0])
	h := sha256.Sum256(append(salt, []byte(pw)...))
	for i := 0; i < 120000; i++ {
		h = sha256.Sum256(append(h[:], salt...))
	}
	return hmac.Equal([]byte(hex.EncodeToString(h[:])), []byte(parts[1]))
}

func loadStore(path string) (*Store, error) {
	s := &Store{path: path}
	raw, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(raw, &s.d); err != nil {
			return nil, fmt.Errorf("data file is corrupted: %w", err)
		}
	}
	if s.d.Secret == "" {
		s.d.Secret = randomHex(32)
	}
	if s.d.NextUserID == 0 {
		s.d.NextUserID, s.d.NextNodeID, s.d.NextTunID = 1, 1, 1
	}
	// ساخت ادمین اولیه
	if len(s.d.Users) == 0 {
		pw := os.Getenv("TPANEL_ADMIN_PASSWORD")
		if pw == "" {
			pw = "admin123"
		}
		user := os.Getenv("TPANEL_ADMIN_USERNAME")
		if user == "" {
			user = "admin"
		}
		s.d.Users = append(s.d.Users, User{ID: s.d.NextUserID, Username: user,
			PasswordHash: hashPassword(pw), Role: "admin", IsActive: true, CreatedAt: nowStr()})
		s.d.NextUserID++
		fmt.Printf("[*] Admin created: %s (password from TPANEL_ADMIN_PASSWORD or default admin123)\n", user)
	}
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.d, "", " ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ---------- توکن نشست (امضاشده با HMAC) ----------

type sessionPayload struct {
	UID int   `json:"uid"`
	Exp int64 `json:"exp"`
}

func (s *Store) makeSession(u User) string {
	p, _ := json.Marshal(sessionPayload{UID: u.ID, Exp: time.Now().Add(24 * time.Hour).Unix()})
	body := base64.RawURLEncoding.EncodeToString(p)
	mac := hmac.New(sha256.New, []byte(s.d.Secret))
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Store) parseSession(tok string) (User, bool) {
	parts := strings.SplitN(tok, ".", 2)
	if len(parts) != 2 {
		return User{}, false
	}
	mac := hmac.New(sha256.New, []byte(s.d.Secret))
	mac.Write([]byte(parts[0]))
	if !hmac.Equal([]byte(base64.RawURLEncoding.EncodeToString(mac.Sum(nil))), []byte(parts[1])) {
		return User{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return User{}, false
	}
	var p sessionPayload
	if json.Unmarshal(raw, &p) != nil || time.Now().Unix() > p.Exp {
		return User{}, false
	}
	for _, u := range s.d.Users {
		if u.ID == p.UID && u.IsActive {
			return u, true
		}
	}
	return User{}, false
}
