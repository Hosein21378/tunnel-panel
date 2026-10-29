package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------- آپدیت خودکار باینری (پنل و ایجنت) ----------
// باینری جدید دانلود، با اجرایش اعتبارسنجی، و اتمیک جایگزین فایل اجرایی فعلی می‌شود.
// بعد از جایگزینی، پروسه با syscall.Exec خودش را با باینری جدید از نو اجرا می‌کند
// (همان PID و همان آرگومان‌ها - چه زیر systemd باشد چه نباشد).

var updateMu sync.Mutex
var updating bool

func compareVersions(a, b string) int {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < 3; i++ {
		var na, nb int
		if i < len(pa) {
			na, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			nb, _ = strconv.Atoi(pb[i])
		}
		if na != nb {
			if na > nb {
				return 1
			}
			return -1
		}
	}
	return 0
}

func downloadToTemp(urls []string) (string, string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", "", err
	}
	dir := filepath.Dir(exe)
	client := &http.Client{Timeout: 180 * time.Second}
	var lastErr error
	for _, url := range urls {
		resp, err := client.Get(url)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != 200 {
			lastErr = fmt.Errorf("%s returned %d", url, resp.StatusCode)
			resp.Body.Close()
			continue
		}
		tmp, err := os.CreateTemp(dir, ".tpanel-update-*")
		if err != nil {
			resp.Body.Close()
			return "", "", err
		}
		_, copyErr := io.Copy(tmp, resp.Body)
		resp.Body.Close()
		if copyErr != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			lastErr = copyErr
			continue
		}
		tmp.Close()
		if err := os.Chmod(tmp.Name(), 0o755); err != nil {
			os.Remove(tmp.Name())
			return "", "", err
		}
		// اعتبارسنجی: باینری دانلودشده باید اجرا شود و نسخه چاپ کند
		out, err := exec.Command(tmp.Name(), "version").Output()
		if err != nil || !strings.HasPrefix(strings.TrimSpace(string(out)), "tpanel ") {
			os.Remove(tmp.Name())
			lastErr = fmt.Errorf("downloaded file from %s is not a valid tpanel binary", url)
			continue
		}
		newVersion := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "tpanel "))
		return tmp.Name(), newVersion, nil
	}
	return "", "", fmt.Errorf("update download failed: %v", lastErr)
}

// دانلود و جایگزینی باینری؛ نسخه جدید را برمی‌گرداند. بعد از موفقیت صدا بزنید: reExec()
func performSelfUpdate(urls []string) (string, error) {
	updateMu.Lock()
	if updating {
		updateMu.Unlock()
		return "", fmt.Errorf("an update is already in progress")
	}
	updating = true
	updateMu.Unlock()

	tmp, newVersion, err := downloadToTemp(urls)
	if err != nil {
		updateMu.Lock()
		updating = false
		updateMu.Unlock()
		return "", err
	}
	exe, err := os.Executable()
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	// جایگزینی اتمیک فایل اجرایی (روی لینوکس حتی هنگام اجرا ممکن است)
	if err := os.Rename(tmp, exe); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("cannot replace binary: %w", err)
	}
	return newVersion, nil
}

// اجرای دوباره همین پروسه با باینری جدید (هرگز برنمی‌گردد اگر موفق شود)
func reExec() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Println("[update] re-exec failed:", err)
		return
	}
	fmt.Println("[update] restarting with new binary...")
	_ = syscall.Exec(exe, os.Args, os.Environ())
	// فقط اگر Exec خطا بدهد به اینجا می‌رسیم
	fmt.Println("[update] exec returned unexpectedly")
}

func panelUpdateURLs() []string {
	return []string{
		fmt.Sprintf("https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main/bin/tpanel-linux-%s", runtime.GOARCH),
		fmt.Sprintf("https://github.com/Hosein21378/tunnel-panel/releases/latest/download/tpanel-linux-%s", runtime.GOARCH),
	}
}

const panelVersionManifest = "https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main/version.json"
