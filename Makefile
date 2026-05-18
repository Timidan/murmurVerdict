# Repo-level Makefile for the Murmur Verdict worktree.
# Project-specific targets (dashboard / daemon / contracts) live in their
# own dirs; this file aggregates cross-cutting checks.

.PHONY: help

help:
	@echo "Available targets:"
	@echo "  make lean-all                  Run Lean FV gates (build + no-sorry + only-declared-axioms)"
	@echo "  make lean-check                Just the lake build"
	@echo "  make lean-no-sorry             Just the sorry grep"
	@echo "  make lean-only-declared-axioms Just the axiom whitelist check"

# ────────────────────────────────────────────────────────────────────
# Lean formal-verification slice (contracts/proofs/MurmurFV/)
# ────────────────────────────────────────────────────────────────────

LEAN_PROOFS_DIR := contracts/proofs/MurmurFV
LEAN_SRC_DIR    := $(LEAN_PROOFS_DIR)/MurmurFV
ELAN            := $(HOME)/.elan/bin/elan
LEAN_TOOLCHAIN  := leanprover/lean4:v4.29.1

.PHONY: lean-check lean-no-sorry lean-only-declared-axioms lean-all

# Build the Lean proof project. Lean 4.29.1 pinned via lean-toolchain.
lean-check:
	@cd $(LEAN_PROOFS_DIR) && $(ELAN) run $(LEAN_TOOLCHAIN) lake build

# Verify the proof source has zero `sorry` placeholders.
lean-no-sorry:
	@if grep -rn 'sorry' $(LEAN_SRC_DIR)/ > /dev/null 2>&1; then \
		echo "sorry found in proofs:"; \
		grep -rn 'sorry' $(LEAN_SRC_DIR)/; \
		exit 1; \
	fi
	@echo "no sorry placeholders ok"

# Verify only the declared axioms are present.
# Allowed axioms: NoDonation, BlockTimeMonotone.
lean-only-declared-axioms:
	@AXIOMS=$$(grep -rn '^axiom ' $(LEAN_SRC_DIR)/ | grep -v -E '(NoDonation|BlockTimeMonotone)'); \
	if [ -n "$$AXIOMS" ]; then \
		echo "undeclared axiom found:"; \
		echo "$$AXIOMS"; \
		exit 1; \
	fi
	@echo "axioms ok (NoDonation + BlockTimeMonotone only)"

# Run all three gates. CI gates on this.
lean-all: lean-check lean-no-sorry lean-only-declared-axioms
	@echo "lean fv slice: build clean, no sorry, no undeclared axioms"
