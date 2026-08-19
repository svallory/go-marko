package main

import (
	"fmt"

	"github.com/svallory/marko-go/runtime"
	views "github.com/svallory/marko-go/examples/hello"
)

func main() {
	w := runtime.New()
	views.Render(w, views.Input{
		Name:  "World",
		Items: []any{"a & b", "<script>", "c"},
	})
	fmt.Print(w.String())
}
