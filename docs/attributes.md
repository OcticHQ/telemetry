# Attributes

The attribute contract is generated, so it lives beside its source rather than
here:

**→ [`contract/ATTRIBUTES.md`](../contract/ATTRIBUTES.md)**

That document is the specification: every key, its type, whether it is
required, which population it belongs to, and which side owns it. It is
generated from [`contract/attributes.yaml`](../contract/attributes.yaml), which
also generates each SDK's constants — so the spec and the code cannot disagree.

For how to work on it, see [`contract/README.md`](../contract/README.md); for
why it is built this way, see
[ADR 0003](../handbook/adr/0003-attribute-contract-as-a-component.md).
