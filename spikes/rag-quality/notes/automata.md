# Automata and Formal Languages

## Finite Automata

A finite automaton is the simplest model of computation: a finite set of states, an input alphabet, and a transition function, with some states marked accepting. A deterministic finite automaton has exactly one transition per state and symbol, while a nondeterministic one may have several or none; the subset construction proves the two recognize the same languages. Finite automata recognize exactly the regular languages, the class describable by regular expressions, and they cannot count unboundedly because they have no memory beyond the current state.

## Context-Free Grammars

A context-free grammar generates a language with production rules that rewrite a single nonterminal into a string of terminals and nonterminals. Context-free languages strictly contain the regular languages and can express balanced nesting, such as matched parentheses, which finite automata cannot. They are recognized by pushdown automata, which augment a finite control with a stack. Programming language syntax is specified with context-free grammars, and parsers turn a token stream into a parse tree according to the grammar.

## The Pumping Lemma

The pumping lemma is the standard tool for proving a language is not regular. It states that any sufficiently long string in a regular language can be split into three parts where the middle part can be repeated any number of times and the result stays in the language. To prove a language like the set of strings with equal numbers of a's and b's is not regular, you assume it is, pick an adversarial string, and show every valid split has a pumping that escapes the language, a contradiction.

## The Halting Problem

The halting problem asks whether there is an algorithm that, given any program and input, decides whether that program eventually halts or runs forever. Turing proved no such algorithm exists by a diagonalization argument: assuming a halting decider exists, you can build a program that halts exactly when the decider says it loops, a contradiction. The halting problem is the canonical undecidable problem, and many other undecidability results are proved by reducing the halting problem to them.
