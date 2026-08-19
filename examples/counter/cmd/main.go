// Sandbox app: a marko-go port of a-h/templ's examples/counter-basic,
// replacing HTMX/templ with a Marko template compiled to Go. Neither
// original nor this port hydrate on the client -- both round-trip via a
// plain form POST -- so a static server-rendered page is a faithful,
// equivalent reproduction, not a lesser one. See PLAN.md.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"sync"

	counter "github.com/svallory/go-marko/examples/counter"
	"github.com/svallory/go-marko/runtime"
)

var (
	mu          sync.Mutex
	globalCount int
	userCounts  = map[string]int{}
)

func sessionID(w http.ResponseWriter, r *http.Request) string {
	cookie, err := r.Cookie("session")
	if err == nil && cookie.Value != "" {
		return cookie.Value
	}
	buf := make([]byte, 16)
	rand.Read(buf)
	id := hex.EncodeToString(buf)
	http.SetCookie(w, &http.Cookie{Name: "session", Value: id, Path: "/"})
	return id
}

func handler(w http.ResponseWriter, r *http.Request) {
	id := sessionID(w, r)

	if r.Method == http.MethodPost {
		r.ParseForm()
		mu.Lock()
		if r.Form.Has("global") {
			globalCount++
		}
		if r.Form.Has("user") {
			userCounts[id]++
		}
		mu.Unlock()
	}

	mu.Lock()
	input := counter.CounterInput{Global: float64(globalCount), User: float64(userCounts[id])}
	mu.Unlock()

	out := runtime.New()
	counter.Counter(out, input)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(out.String()))
}

func main() {
	http.HandleFunc("/", handler)
	fmt.Println("listening on :8080")
	if err := http.ListenAndServe("127.0.0.1:8080", nil); err != nil {
		log.Printf("error listening: %v", err)
	}
}
