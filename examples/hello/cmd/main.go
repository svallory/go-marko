package main

import (
	"fmt"

	hello "github.com/svallory/go-marko/examples/hello"
	"github.com/svallory/go-marko/runtime"
)

func main() {
	w := runtime.New()
	hello.Hello(w, hello.HelloInput{
		Name:  "World",
		Items: []string{"a & b", "<script>", "c"},
	})
	fmt.Print(w.String())
}
