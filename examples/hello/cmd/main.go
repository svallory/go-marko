package main

import (
	"fmt"

	"github.com/svallory/go-marko/runtime"
	hello "github.com/svallory/go-marko/examples/hello"
)

func main() {
	w := runtime.New()
	hello.Hello(w, hello.HelloInput{
		Name:  "World",
		Items: []string{"a & b", "<script>", "c"},
	})
	fmt.Print(w.String())
}
