package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

const Version = "2.2.0"

func usage() {
	fmt.Println(`Tunnel Panel v` + Version + ` - single binary, zero dependencies

Usage:
  tpanel panel   [--host 0.0.0.0] [--port 8080] [--data /var/lib/tpanel/data.json]
  tpanel agent   --panel http://PANEL:8080 --token TOKEN [--relay-port 10000] [--poll 10]
  tpanel reset-password --data /var/lib/tpanel/data.json [--username admin] --password NEW
  tpanel version`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}
	switch os.Args[1] {
	case "panel":
		fs := flag.NewFlagSet("panel", flag.ExitOnError)
		host := fs.String("host", "0.0.0.0", "listen host")
		port := fs.Int("port", 8080, "listen port")
		data := fs.String("data", "/var/lib/tpanel/data.json", "data file")
		_ = fs.Parse(os.Args[2:])
		if err := runPanel(*host, *port, *data); err != nil {
			fmt.Fprintln(os.Stderr, "panel error:", err)
			os.Exit(1)
		}
	case "agent":
		fs := flag.NewFlagSet("agent", flag.ExitOnError)
		panel := fs.String("panel", os.Getenv("PANEL_URL"), "panel base URL")
		token := fs.String("token", os.Getenv("NODE_TOKEN"), "node token")
		relay := fs.Int("relay-port", envInt("RELAY_PORT", 10000), "relay port")
		poll := fs.Int("poll", envInt("POLL_INTERVAL", 10), "poll seconds")
		_ = fs.Parse(os.Args[2:])
		if err := runAgent(*panel, *token, *relay, *poll); err != nil {
			fmt.Fprintln(os.Stderr, "agent error:", err)
			os.Exit(1)
		}
	case "reset-password":
		fs := flag.NewFlagSet("reset-password", flag.ExitOnError)
		data := fs.String("data", "/var/lib/tpanel/data.json", "data file")
		username := fs.String("username", "admin", "username")
		password := fs.String("password", "", "new password")
		_ = fs.Parse(os.Args[2:])
		if *password == "" {
			fmt.Fprintln(os.Stderr, "--password is required")
			os.Exit(2)
		}
		if err := resetPassword(*data, *username, *password); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("password changed for", *username)
	case "help", "-h", "--help":
		usage()
	case "version", "--version", "-v":
		fmt.Println("tpanel", Version)
	default:
		if strings.HasPrefix(os.Args[1], "-") {
			usage()
			return
		}
		fmt.Fprintln(os.Stderr, "unknown command:", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil || n <= 0 {
		return def
	}
	return n
}

func resetPassword(dataPath, username, newPassword string) error {
	st, err := loadStore(dataPath)
	if err != nil {
		return err
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	for i, u := range st.d.Users {
		if u.Username == username {
			st.d.Users[i].PasswordHash = hashPassword(newPassword)
			st.d.Users[i].IsActive = true
			return st.saveLocked()
		}
	}
	return fmt.Errorf("user %q not found", username)
}
