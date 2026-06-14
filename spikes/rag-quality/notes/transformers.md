# Transformer Neural Networks

## Self-Attention

Self-attention lets every position in a sequence look at every other position and decide how much to weigh it when building its own representation. Each token is projected into a query, a key, and a value; the attention weight between two tokens is the scaled dot product of one's query with the other's key, passed through a softmax. The output for a position is the weighted sum of all values. Because every pair interacts directly, the transformer captures long-range dependencies that recurrent networks struggle to propagate.

## Multi-Head Attention

Multi-head attention runs several attention operations in parallel, each with its own learned query, key, and value projections, then concatenates their outputs and projects them back down. Each head can specialize, attending to different kinds of relationships — one might track syntactic agreement while another tracks coreference. Splitting the model dimension across heads keeps the total computation similar to a single large attention while letting the model jointly attend to information from multiple representation subspaces at once.

## Positional Encoding

Because self-attention is permutation-invariant and has no built-in notion of order, transformers add positional information to the token embeddings. The original design uses fixed sinusoidal functions of different frequencies, so each position gets a unique pattern and the model can learn to attend by relative offset. Learned positional embeddings are a common alternative, and later variants like rotary embeddings encode position by rotating the query and key vectors, which generalizes better to sequence lengths unseen during training.

## Encoder, Decoder, and Pretraining

The original transformer pairs an encoder, which reads the whole input with bidirectional attention, and a decoder, which generates output one token at a time using masked attention so it cannot peek ahead. BERT keeps only the encoder and pretrains with a masked-language-model objective, making it strong for understanding tasks. GPT-style models keep only the decoder and pretrain by predicting the next token, making them strong generators. The architecture and the pretraining objective together determine what a model is good at.
