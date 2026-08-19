package views

// Input is hand-written, not generated. Field names must be the
// capitalized form of the corresponding `input.xyz` reference in the
// .marko source (input.name -> Name, input.items -> Items). Slice/list
// fields must currently be []any -- see the []any contract in PLAN.md.
type Input struct {
	Name  string
	Items []any
}
