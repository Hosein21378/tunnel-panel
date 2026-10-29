package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed web/index.html
var webIndex []byte

//go:embed web/app.js
var webJS []byte

//go:embed web/style.css
var webCSS []byte

//go:embed manager.sh
var managerScript []byte

type panelServer struct{ st *Store }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"detail": msg})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	return t, err == nil
}

func tunnelActive(t Tunnel) bool {
	if !t.Enabled {
		return false
	}
	if exp, ok := parseTime(t.ExpiresAt); ok && time.Now().After(exp) {
		return false
	}
	if t.TrafficLimitBytes > 0 && t.BytesIn+t.BytesOut >= t.TrafficLimitBytes {
		return false
	}
	return true
}

func (p *panelServer) nodeOut(n Node) map[string]any {
	online := false
	if ts, ok := parseTime(n.LastSeen); ok && time.Since(ts) < 35*time.Second {
		online = true
	}
	host := n.Host
	if host == "" {
		host = n.ReportedIP
	}
	memPct, diskPct := 0.0, 0.0
	if n.MemTotalBytes > 0 {
		memPct = float64(n.MemUsedBytes) / float64(n.MemTotalBytes) * 100
	}
	if n.DiskTotalBytes > 0 {
		diskPct = float64(n.DiskUsedBytes) / float64(n.DiskTotalBytes) * 100
	}
	return map[string]any{"id": n.ID, "name": n.Name, "host": host, "reported_ip": n.ReportedIP,
		"token": n.Token, "description": n.Description, "agent_version": n.AgentVersion,
		"os_info": n.OSInfo, "relay_port": n.RelayPort, "online": online,
		"last_seen": nilOrStr(n.LastSeen), "created_at": n.CreatedAt,
		"resources": map[string]any{"cpu_percent": n.CPUPercent, "mem_used": n.MemUsedBytes,
			"mem_total": n.MemTotalBytes, "mem_percent": memPct, "disk_used": n.DiskUsedBytes,
			"disk_total": n.DiskTotalBytes, "disk_percent": diskPct, "load1": n.Load1,
			"uptime_seconds": n.UptimeSeconds, "num_cpu": n.NumCPU}}
}

func nilOrStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func normTransport(tr string) string {
	switch tr {
	case "tcpmux", "ws", "wss", "auto":
		return tr
	}
	return "tcp"
}

func (p *panelServer) tunnelOut(t Tunnel) map[string]any {
	srcName, dstName := "?", ""
	for _, n := range p.st.d.Nodes {
		if n.ID == t.SourceNodeID {
			srcName = n.Name
		}
		if n.ID == t.DestNodeID {
			dstName = n.Name
		}
	}
	expired := false
	if exp, ok := parseTime(t.ExpiresAt); ok && time.Now().After(exp) {
		expired = true
	}
	over := t.TrafficLimitBytes > 0 && t.BytesIn+t.BytesOut >= t.TrafficLimitBytes
	var limit any
	if t.TrafficLimitBytes > 0 {
		limit = t.TrafficLimitBytes
	}
	return map[string]any{"id": t.ID, "name": t.Name, "type": t.Type, "protocol": t.Protocol,
		"source_node_id": t.SourceNodeID, "source_node_name": srcName,
		"dest_node_id": t.DestNodeID, "dest_node_name": dstName,
		"listen_port": t.ListenPort, "target_host": t.TargetHost, "target_port": t.TargetPort, "transport": normTransport(t.Transport),
		"enabled": t.Enabled, "active": tunnelActive(t), "expired": expired, "over_limit": over,
		"bytes_in": t.BytesIn, "bytes_out": t.BytesOut, "connections": t.Connections,
		"traffic_limit_bytes": limit, "expires_at": nilOrStr(t.ExpiresAt),
		"owner_id": t.OwnerID, "created_at": t.CreatedAt}
}

func (p *panelServer) authUser(w http.ResponseWriter, r *http.Request) (User, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		errJSON(w, 401, "لاگین لازم است")
		return User{}, false
	}
	p.st.mu.Lock()
	defer p.st.mu.Unlock()
	u, ok := p.st.parseSession(strings.TrimPrefix(h, "Bearer "))
	if !ok {
		errJSON(w, 401, "توکن نامعتبر یا منقضی شده")
		return User{}, false
	}
	return u, true
}

func (p *panelServer) authNode(w http.ResponseWriter, r *http.Request) (int, bool) {
	tok := r.Header.Get("X-Node-Token")
	p.st.mu.Lock()
	defer p.st.mu.Unlock()
	for i, n := range p.st.d.Nodes {
		if n.Token == tok && tok != "" {
			p.st.d.Nodes[i].LastSeen = nowStr()
			_ = p.st.saveLocked()
			return n.ID, true
		}
	}
	errJSON(w, 401, "توکن نود نامعتبر است")
	return 0, false
}

func (p *panelServer) findNode(id int) (Node, bool) {
	for _, n := range p.st.d.Nodes {
		if n.ID == id {
			return n, true
		}
	}
	return Node{}, false
}

func validateTunnelInput(st *Store, typ, proto string, srcID, dstID, listen, target int, excludeID int) string {
	if typ != "forward" && typ != "reverse" {
		return "نوع تونل نامعتبر است"
	}
	if proto != "tcp" && proto != "udp" && proto != "both" {
		return "پروتکل نامعتبر است"
	}
	if typ == "reverse" && proto != "tcp" {
		return "تونل ریورس فعلا فقط TCP است"
	}
	if dstID > 0 && dstID == srcID {
		return "سرور ورودی و سرور خروجی نمی‌توانند یکی باشند"
	}
	if typ == "reverse" && dstID == 0 {
		return "برای تونل ریورس، سرور مقصد (پشت NAT) را انتخاب کنید"
	}
	if listen < 1 || listen > 65535 || target < 1 || target > 65535 {
		return "پورت نامعتبر است"
	}
	for _, t := range st.d.Tunnels {
		if t.ID != excludeID && t.SourceNodeID == srcID && t.ListenPort == listen && t.Enabled {
			return "این پورت روی سرور مبدا قبلا توسط تونل دیگری استفاده شده"
		}
	}
	return ""
}

func runPanel(host string, port int, dataPath string) error {
	st, err := loadStore(dataPath)
	if err != nil {
		return err
	}
	p := &panelServer{st: st}
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(webIndex)
		case "/static/app.js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			_, _ = w.Write(webJS)
		case "/static/style.css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
			_, _ = w.Write(webCSS)
		case "/health":
			writeJSON(w, 200, map[string]string{"status": "ok", "version": Version})
		case "/manager.sh", "/install-agent.sh":
			w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
			_, _ = w.Write(managerScript)
		case "/tpanel", "/agent-binary":
			exe, err := os.Executable()
			if err != nil {
				errJSON(w, 500, "binary not found")
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			http.ServeFile(w, r, exe)
		default:
			http.NotFound(w, r)
		}
	})

	// ---------- احراز هویت ----------
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if readJSON(r, &in) != nil {
			errJSON(w, 400, "بدنه نامعتبر")
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		for _, u := range st.d.Users {
			if u.Username == in.Username && u.IsActive && verifyPassword(in.Password, u.PasswordHash) {
				writeJSON(w, 200, map[string]any{"token": st.makeSession(u), "username": u.Username, "role": u.Role})
				return
			}
		}
		errJSON(w, 401, "نام کاربری یا رمز اشتباه است")
	})
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if u, ok := p.authUser(w, r); ok {
			writeJSON(w, 200, map[string]any{"id": u.ID, "username": u.Username, "role": u.Role})
		}
	})

	// ---------- کاربران ----------
	mux.HandleFunc("/api/users", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		if u.Role != "admin" {
			errJSON(w, 403, "فقط ادمین دسترسی دارد")
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		if r.Method == http.MethodGet {
			out := []map[string]any{}
			for _, x := range st.d.Users {
				out = append(out, map[string]any{"id": x.ID, "username": x.Username, "role": x.Role, "is_active": x.IsActive})
			}
			writeJSON(w, 200, out)
			return
		}
		if r.Method == http.MethodPost {
			var in struct {
				Username string `json:"username"`
				Password string `json:"password"`
				Role     string `json:"role"`
			}
			if readJSON(r, &in) != nil || in.Username == "" || in.Password == "" {
				errJSON(w, 400, "نام کاربری و رمز لازم است")
				return
			}
			if in.Role != "admin" {
				in.Role = "user"
			}
			for _, x := range st.d.Users {
				if x.Username == in.Username {
					errJSON(w, 400, "این نام کاربری قبلا گرفته شده")
					return
				}
			}
			nu := User{ID: st.d.NextUserID, Username: in.Username, PasswordHash: hashPassword(in.Password),
				Role: in.Role, IsActive: true, CreatedAt: nowStr()}
			st.d.NextUserID++
			st.d.Users = append(st.d.Users, nu)
			_ = st.saveLocked()
			writeJSON(w, 200, map[string]any{"id": nu.ID, "username": nu.Username, "role": nu.Role})
			return
		}
		errJSON(w, 405, "method not allowed")
	})
	mux.HandleFunc("/api/users/", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		if u.Role != "admin" {
			errJSON(w, 403, "فقط ادمین دسترسی دارد")
			return
		}
		id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/users/"))
		st.mu.Lock()
		defer st.mu.Unlock()
		idx := -1
		for i, x := range st.d.Users {
			if x.ID == id {
				idx = i
			}
		}
		if idx < 0 {
			errJSON(w, 404, "کاربر یافت نشد")
			return
		}
		switch r.Method {
		case http.MethodPut:
			var in struct {
				Pwd      *string `json:"pwd"`
				Role     *string `json:"role"`
				IsActive *bool   `json:"is_active"`
			}
			_ = readJSON(r, &in)
			if in.Pwd != nil && *in.Pwd != "" {
				st.d.Users[idx].PasswordHash = hashPassword(*in.Pwd)
			}
			if in.Role != nil && (*in.Role == "admin" || *in.Role == "user") {
				st.d.Users[idx].Role = *in.Role
			}
			if in.IsActive != nil {
				st.d.Users[idx].IsActive = *in.IsActive
			}
			_ = st.saveLocked()
			writeJSON(w, 200, map[string]bool{"ok": true})
		case http.MethodDelete:
			if id == u.ID {
				errJSON(w, 400, "نمی‌توانید خودتان را حذف کنید")
				return
			}
			st.d.Users = append(st.d.Users[:idx], st.d.Users[idx+1:]...)
			_ = st.saveLocked()
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			errJSON(w, 405, "method not allowed")
		}
	})

	// ---------- سرورها ----------
	mux.HandleFunc("/api/nodes", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			out := []map[string]any{}
			for _, n := range st.d.Nodes {
				out = append(out, p.nodeOut(n))
			}
			writeJSON(w, 200, out)
		case http.MethodPost:
			var in struct {
				Name        string `json:"name"`
				Host        string `json:"host"`
				Description string `json:"description"`
			}
			if readJSON(r, &in) != nil || in.Name == "" {
				errJSON(w, 400, "نام سرور لازم است")
				return
			}
			tokenVal := randomToken()
			n := Node{ID: st.d.NextNodeID, Name: in.Name, Host: in.Host, Description: in.Description,
				Token: tokenVal, RelayPort: 10000, CreatedBy: u.ID, CreatedAt: nowStr()}
			st.d.NextNodeID++
			st.d.Nodes = append(st.d.Nodes, n)
			_ = st.saveLocked()
			out := p.nodeOut(n)
			base := "http://" + r.Host
			out["install_command"] = fmt.Sprintf("bash <(curl -fsSL %s/manager.sh) agent --panel %s --token %s", base, base, n.Token)
			out["join_code"] = makeJoinCode(base, n.Token, n.RelayPort)
			writeJSON(w, 200, out)
		default:
			errJSON(w, 405, "method not allowed")
		}
	})
	mux.HandleFunc("/api/nodes/", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := p.authUser(w, r); !ok {
			return
		}
		id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/nodes/"))
		st.mu.Lock()
		defer st.mu.Unlock()
		idx := -1
		for i, n := range st.d.Nodes {
			if n.ID == id {
				idx = i
			}
		}
		if idx < 0 {
			errJSON(w, 404, "سرور یافت نشد")
			return
		}
		switch r.Method {
		case http.MethodPut:
			var in struct {
				Name        *string `json:"name"`
				Host        *string `json:"host"`
				Description *string `json:"description"`
			}
			_ = readJSON(r, &in)
			if in.Name != nil {
				st.d.Nodes[idx].Name = *in.Name
			}
			if in.Host != nil {
				st.d.Nodes[idx].Host = *in.Host
			}
			if in.Description != nil {
				st.d.Nodes[idx].Description = *in.Description
			}
			_ = st.saveLocked()
			writeJSON(w, 200, p.nodeOut(st.d.Nodes[idx]))
		case http.MethodDelete:
			for _, t := range st.d.Tunnels {
				if t.SourceNodeID == id || t.DestNodeID == id {
					errJSON(w, 400, "این سرور در یک تونل استفاده شده؛ اول تونل را حذف کنید")
					return
				}
			}
			st.d.Nodes = append(st.d.Nodes[:idx], st.d.Nodes[idx+1:]...)
			_ = st.saveLocked()
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			errJSON(w, 405, "method not allowed")
		}
	})

	// ---------- تونل‌ها ----------
	mux.HandleFunc("/api/tunnels", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			out := []map[string]any{}
			for _, t := range st.d.Tunnels {
				if u.Role != "admin" && t.OwnerID != u.ID {
					continue
				}
				out = append(out, p.tunnelOut(t))
			}
			writeJSON(w, 200, out)
		case http.MethodPost:
			var in struct {
				Name         string   `json:"name"`
				Type         string   `json:"type"`
				Protocol     string   `json:"protocol"`
				SourceNodeID int      `json:"source_node_id"`
				DestNodeID   *int     `json:"dest_node_id"`
				ListenPort   int      `json:"listen_port"`
				TargetHost   string   `json:"target_host"`
				TargetPort   int      `json:"target_port"`
				Transport    string   `json:"transport"`
				TrafficGB    *float64 `json:"traffic_limit_gb"`
				ExpiresAt    *string  `json:"expires_at"`
			}
			if readJSON(r, &in) != nil || in.Name == "" {
				errJSON(w, 400, "نام تونل لازم است")
				return
			}
			dst := 0
			if in.DestNodeID != nil {
				dst = *in.DestNodeID
			}
			if msg := validateTunnelInput(st, in.Type, in.Protocol, in.SourceNodeID, dst, in.ListenPort, in.TargetPort, 0); msg != "" {
				errJSON(w, 400, msg)
				return
			}
			if _, ok := p.findNode(in.SourceNodeID); !ok {
				errJSON(w, 400, "سرور مبدا یافت نشد")
				return
			}
			if in.Type == "reverse" {
				if _, ok := p.findNode(dst); !ok {
					errJSON(w, 400, "سرور مقصد یافت نشد")
					return
				}
			}
			if in.TargetHost == "" {
				in.TargetHost = "127.0.0.1"
			}
			tokenVal := randomToken()
			t := Tunnel{ID: st.d.NextTunID, Name: in.Name, Type: in.Type, Protocol: in.Protocol,
				SourceNodeID: in.SourceNodeID, DestNodeID: dst, ListenPort: in.ListenPort,
				TargetHost: in.TargetHost, TargetPort: in.TargetPort, Transport: normTransport(in.Transport), Token: tokenVal,
				Enabled: true, OwnerID: u.ID, CreatedAt: nowStr()}
			st.d.NextTunID++
			if in.TrafficGB != nil && *in.TrafficGB > 0 {
				t.TrafficLimitBytes = int64(*in.TrafficGB * 1024 * 1024 * 1024)
			}
			if in.ExpiresAt != nil && *in.ExpiresAt != "" {
				if exp, err := time.Parse(time.RFC3339, *in.ExpiresAt); err == nil {
					t.ExpiresAt = exp.UTC().Format(time.RFC3339)
				}
			}
			st.d.Tunnels = append(st.d.Tunnels, t)
			_ = st.saveLocked()
			writeJSON(w, 200, p.tunnelOut(t))
		default:
			errJSON(w, 405, "method not allowed")
		}
	})
	mux.HandleFunc("/api/tunnels/", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/api/tunnels/")
		parts := strings.Split(rest, "/")
		id, _ := strconv.Atoi(parts[0])
		action := ""
		if len(parts) > 1 {
			action = parts[1]
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		idx := -1
		for i, t := range st.d.Tunnels {
			if t.ID == id {
				idx = i
			}
		}
		if idx < 0 {
			errJSON(w, 404, "تونل یافت نشد")
			return
		}
		t := &st.d.Tunnels[idx]
		if u.Role != "admin" && t.OwnerID != u.ID {
			errJSON(w, 403, "به این تونل دسترسی ندارید")
			return
		}
		switch {
		case r.Method == http.MethodDelete && action == "":
			st.d.Tunnels = append(st.d.Tunnels[:idx], st.d.Tunnels[idx+1:]...)
			kept := st.d.Snapshots[:0]
			for _, s := range st.d.Snapshots {
				if s.TunnelID != id {
					kept = append(kept, s)
				}
			}
			st.d.Snapshots = kept
			_ = st.saveLocked()
			writeJSON(w, 200, map[string]bool{"ok": true})
		case r.Method == http.MethodPost && action == "toggle":
			if !t.Enabled {
				if msg := validateTunnelInput(st, t.Type, t.Protocol, t.SourceNodeID, t.DestNodeID, t.ListenPort, t.TargetPort, t.ID); msg != "" {
					errJSON(w, 400, msg)
					return
				}
			}
			t.Enabled = !t.Enabled
			_ = st.saveLocked()
			writeJSON(w, 200, p.tunnelOut(*t))
		case r.Method == http.MethodPost && action == "reset-traffic":
			t.BytesIn, t.BytesOut, t.Connections = 0, 0, 0
			_ = st.saveLocked()
			writeJSON(w, 200, map[string]bool{"ok": true})
		case r.Method == http.MethodPut && action == "":
			var in struct {
				Name       *string  `json:"name"`
				Protocol   *string  `json:"protocol"`
				ListenPort *int     `json:"listen_port"`
				TargetHost *string  `json:"target_host"`
				TargetPort *int     `json:"target_port"`
				DestNodeID *int     `json:"dest_node_id"`
				Transport  *string  `json:"transport"`
				TrafficGB  *float64 `json:"traffic_limit_gb"`
				ExpiresAt  *string  `json:"expires_at"`
			}
			_ = readJSON(r, &in)
			proto, listen, dst := t.Protocol, t.ListenPort, t.DestNodeID
			if in.Protocol != nil {
				proto = *in.Protocol
			}
			if in.ListenPort != nil {
				listen = *in.ListenPort
			}
			if in.DestNodeID != nil {
				dst = *in.DestNodeID
			}
			if msg := validateTunnelInput(st, t.Type, proto, t.SourceNodeID, dst, listen, t.TargetPort, t.ID); msg != "" {
				errJSON(w, 400, msg)
				return
			}
			if in.Name != nil {
				t.Name = *in.Name
			}
			t.Protocol, t.ListenPort, t.DestNodeID = proto, listen, dst
			if in.Transport != nil {
				t.Transport = normTransport(*in.Transport)
			}
			if in.TargetHost != nil {
				t.TargetHost = *in.TargetHost
			}
			if in.TargetPort != nil {
				t.TargetPort = *in.TargetPort
			}
			if in.TrafficGB != nil {
				if *in.TrafficGB > 0 {
					t.TrafficLimitBytes = int64(*in.TrafficGB * 1024 * 1024 * 1024)
				} else {
					t.TrafficLimitBytes = 0
				}
			}
			if in.ExpiresAt != nil {
				if *in.ExpiresAt == "" {
					t.ExpiresAt = ""
				} else if exp, err := time.Parse(time.RFC3339, *in.ExpiresAt); err == nil {
					t.ExpiresAt = exp.UTC().Format(time.RFC3339)
				}
			}
			_ = st.saveLocked()
			writeJSON(w, 200, p.tunnelOut(*t))
		default:
			errJSON(w, 405, "method not allowed")
		}
	})

	// ---------- داشبورد ----------
	mux.HandleFunc("/api/dashboard", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		online := 0
		for _, n := range st.d.Nodes {
			if ts, ok2 := parseTime(n.LastSeen); ok2 && time.Since(ts) < 35*time.Second {
				online++
			}
		}
		var bins, bouts, conns int64
		active, total := 0, 0
		myTuns := map[int]bool{}
		for _, t := range st.d.Tunnels {
			if u.Role != "admin" && t.OwnerID != u.ID {
				continue
			}
			myTuns[t.ID] = true
			total++
			if t.Enabled {
				active++
			}
			bins += t.BytesIn
			bouts += t.BytesOut
			conns += t.Connections
		}
		type pt struct {
			Time string `json:"time"`
			In   int64  `json:"in"`
			Out  int64  `json:"out"`
		}
		chartMap := map[string]*pt{}
		cutoff := time.Now().Add(-24 * time.Hour).Unix()
		for _, s := range st.d.Snapshots {
			if s.TS < cutoff || !myTuns[s.TunnelID] {
				continue
			}
			key := time.Unix(s.TS, 0).UTC().Format("15:00")
			if chartMap[key] == nil {
				chartMap[key] = &pt{Time: key}
			}
			chartMap[key].In += s.BytesIn
			chartMap[key].Out += s.BytesOut
		}
		chart := []pt{}
		for _, v := range chartMap {
			chart = append(chart, *v)
		}
		sort.Slice(chart, func(i, j int) bool { return chart[i].Time < chart[j].Time })
		writeJSON(w, 200, map[string]any{"nodes_total": len(st.d.Nodes), "nodes_online": online,
			"tunnels_total": total, "tunnels_active": active, "bytes_in": bins, "bytes_out": bouts,
			"connections": conns, "chart": chart})
	})

	// ---------- سیستم و آپدیت از داخل پنل ----------
	mux.HandleFunc("/api/system/check", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		if u.Role != "admin" {
			errJSON(w, 403, "فقط ادمین دسترسی دارد")
			return
		}
		out := map[string]any{"current": Version, "latest": "", "update_available": false, "notes": "", "error": ""}
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Get(panelVersionManifest)
		if err != nil {
			out["error"] = "بررسی آپدیت ممکن نشد (اینترنت سرور پنل؟)"
			writeJSON(w, 200, out)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			out["error"] = "فایل نسخه روی گیت‌هاب پیدا نشد"
			writeJSON(w, 200, out)
			return
		}
		var man struct {
			Version string `json:"version"`
			Notes   string `json:"notes"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&man); err != nil || man.Version == "" {
			out["error"] = "فایل نسخه نامعتبر است"
			writeJSON(w, 200, out)
			return
		}
		out["latest"] = man.Version
		out["notes"] = man.Notes
		out["update_available"] = compareVersions(man.Version, Version) > 0
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("/api/system/update", func(w http.ResponseWriter, r *http.Request) {
		u, ok := p.authUser(w, r)
		if !ok {
			return
		}
		if u.Role != "admin" || r.Method != http.MethodPost {
			errJSON(w, 403, "فقط ادمین و با متد POST")
			return
		}
		newVersion, err := performSelfUpdate(panelUpdateURLs())
		if err != nil {
			fmt.Println("[update] failed:", err)
			errJSON(w, 502, "آپدیت ناموفق بود: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "new_version": newVersion,
			"message": "باینری جدید نصب شد؛ پنل در حال ری‌استارت است..."})
		// بعد از ارسال پاسخ، با باینری جدید از نو اجرا می‌شویم
		go func() {
			time.Sleep(700 * time.Millisecond)
			reExec()
		}()
	})

	// ---------- API ایجنت ----------
	agentTouch := func(w http.ResponseWriter, r *http.Request) (int, bool) { return p.authNode(w, r) }
	mux.HandleFunc("/api/agent/register", func(w http.ResponseWriter, r *http.Request) {
		id, ok := agentTouch(w, r)
		if !ok {
			return
		}
		var in struct {
			IP        string `json:"ip"`
			Version   string `json:"version"`
			OSInfo    string `json:"os_info"`
			RelayPort int    `json:"relay_port"`
		}
		_ = readJSON(r, &in)
		st.mu.Lock()
		defer st.mu.Unlock()
		for i, n := range st.d.Nodes {
			if n.ID == id {
				st.d.Nodes[i].AgentVersion = in.Version
				st.d.Nodes[i].OSInfo = in.OSInfo
				if in.IP != "" {
					st.d.Nodes[i].ReportedIP = in.IP
				}
				if in.RelayPort > 0 {
					st.d.Nodes[i].RelayPort = in.RelayPort
				}
				_ = st.saveLocked()
				writeJSON(w, 200, map[string]any{"node_id": id, "name": n.Name})
				return
			}
		}
	})
	mux.HandleFunc("/api/agent/config", func(w http.ResponseWriter, r *http.Request) {
		id, ok := agentTouch(w, r)
		if !ok {
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		me, _ := p.findNode(id)
		listen := []map[string]any{}
		rev := []map[string]any{}
		acceptDirect := []map[string]any{}
		for _, t := range st.d.Tunnels {
			if !tunnelActive(t) {
				continue
			}
			if t.SourceNodeID == id {
				item := map[string]any{"id": t.ID, "type": t.Type, "protocol": t.Protocol,
					"listen_port": t.ListenPort, "target_host": t.TargetHost,
					"target_port": t.TargetPort, "token": t.Token, "transport": normTransport(t.Transport)}
				if t.Type == "forward" && t.DestNodeID > 0 {
					if dn, ok := p.findNode(t.DestNodeID); ok {
						host := dn.Host
						if host == "" {
							host = dn.ReportedIP
						}
						item["dest_relay_host"] = host
						item["dest_relay_port"] = dn.RelayPort
					}
				}
				listen = append(listen, item)
			}
			if t.Type == "forward" && t.DestNodeID == id {
				acceptDirect = append(acceptDirect, map[string]any{"id": t.ID, "token": t.Token,
					"transport": normTransport(t.Transport),
					"target_host": t.TargetHost, "target_port": t.TargetPort})
			}
			if t.Type == "reverse" && t.DestNodeID == id {
				if src, ok := p.findNode(t.SourceNodeID); ok {
					host := src.Host
					if host == "" {
						host = src.ReportedIP
					}
					rev = append(rev, map[string]any{"id": t.ID, "token": t.Token,
						"relay_host": host, "relay_port": src.RelayPort, "transport": normTransport(t.Transport),
						"target_host": t.TargetHost, "target_port": t.TargetPort})
				}
			}
		}
		selfUpdate := me.AgentVersion != "" && compareVersions(me.AgentVersion, Version) < 0
		writeJSON(w, 200, map[string]any{"listen": listen, "reverse_connect": rev, "accept_direct": acceptDirect, "relay_port": me.RelayPort, "self_update": selfUpdate})
	})
	mux.HandleFunc("/api/agent/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		id, ok := agentTouch(w, r)
		if !ok {
			return
		}
		var in struct {
			IP             string  `json:"ip"`
			Version        string  `json:"version"`
			OSInfo         string  `json:"os_info"`
			RelayPort      int     `json:"relay_port"`
			CPUPercent     float64 `json:"cpu_percent"`
			MemUsedBytes   int64   `json:"mem_used_bytes"`
			MemTotalBytes  int64   `json:"mem_total_bytes"`
			DiskUsedBytes  int64   `json:"disk_used_bytes"`
			DiskTotalBytes int64   `json:"disk_total_bytes"`
			Load1          float64 `json:"load1"`
			UptimeSeconds  int64   `json:"uptime_seconds"`
			NumCPU         int     `json:"num_cpu"`
			Stats          []struct {
				TunnelID    int   `json:"tunnel_id"`
				BytesIn     int64 `json:"bytes_in"`
				BytesOut    int64 `json:"bytes_out"`
				Connections int64 `json:"connections"`
			} `json:"stats"`
		}
		_ = readJSON(r, &in)
		st.mu.Lock()
		defer st.mu.Unlock()
		for i, n := range st.d.Nodes {
			if n.ID == id {
				if in.IP != "" {
					st.d.Nodes[i].ReportedIP = in.IP
				}
				if in.Version != "" {
					st.d.Nodes[i].AgentVersion = in.Version
				}
				if in.OSInfo != "" {
					st.d.Nodes[i].OSInfo = in.OSInfo
				}
				if in.RelayPort > 0 {
					st.d.Nodes[i].RelayPort = in.RelayPort
				}
				st.d.Nodes[i].CPUPercent = in.CPUPercent
				st.d.Nodes[i].MemUsedBytes = in.MemUsedBytes
				st.d.Nodes[i].MemTotalBytes = in.MemTotalBytes
				st.d.Nodes[i].DiskUsedBytes = in.DiskUsedBytes
				st.d.Nodes[i].DiskTotalBytes = in.DiskTotalBytes
				st.d.Nodes[i].Load1 = in.Load1
				st.d.Nodes[i].UptimeSeconds = in.UptimeSeconds
				st.d.Nodes[i].NumCPU = in.NumCPU
			}
		}
		for _, s := range in.Stats {
			for i, t := range st.d.Tunnels {
				if t.ID == s.TunnelID {
					st.d.Tunnels[i].BytesIn += max64(s.BytesIn)
					st.d.Tunnels[i].BytesOut += max64(s.BytesOut)
					st.d.Tunnels[i].Connections += max64(s.Connections)
					if s.BytesIn != 0 || s.BytesOut != 0 || s.Connections != 0 {
						st.d.Snapshots = append(st.d.Snapshots, Snapshot{TunnelID: t.ID, TS: time.Now().Unix(),
							BytesIn: s.BytesIn, BytesOut: s.BytesOut, Connections: s.Connections})
					}
				}
			}
		}
		if len(st.d.Snapshots) > 5000 {
			st.d.Snapshots = st.d.Snapshots[len(st.d.Snapshots)-5000:]
		}
		_ = st.saveLocked()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	addr := fmt.Sprintf("%s:%d", host, port)
	fmt.Printf("[*] Tunnel Panel v%s listening on http://%s  (data: %s)\n", Version, addr, dataPath)
	srv := &http.Server{Addr: addr, Handler: mux}
	return srv.ListenAndServe()
}

func max64(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}
