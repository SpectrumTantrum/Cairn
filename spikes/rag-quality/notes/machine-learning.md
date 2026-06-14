# Machine Learning Basics

## Supervised versus Unsupervised Learning

Supervised learning trains a model on labeled examples, learning a mapping from inputs to known target outputs so it can predict labels for new inputs; classification and regression are its two forms. Unsupervised learning works on unlabeled data, discovering structure such as clusters or a low-dimensional representation without being told the right answer. A third paradigm, reinforcement learning, learns from reward signals by interacting with an environment rather than from a fixed labeled dataset.

## Overfitting and Regularization

Overfitting happens when a model memorizes the training data, including its noise, and therefore generalizes poorly to unseen data. The symptom is low training error but high validation error. Regularization combats it by penalizing model complexity: L2 regularization shrinks weights toward zero, L1 drives some weights exactly to zero for sparsity, and dropout randomly disables units during training. Gathering more data, simplifying the model, and early stopping are other defenses. The goal is to land in the sweet spot between underfitting and overfitting.

## The Bias-Variance Tradeoff

A model's expected error decomposes into bias, variance, and irreducible noise. Bias is error from wrong assumptions that make the model too simple to capture the pattern, causing underfitting. Variance is sensitivity to the particular training sample, causing overfitting. Reducing one usually raises the other: a complex model lowers bias but raises variance, while a simple model does the reverse. The art of model selection is finding the complexity that minimizes their sum on unseen data.

## Gradient Descent

Gradient descent minimizes a loss function by repeatedly stepping in the direction of steepest descent, the negative gradient, scaled by a learning rate. A learning rate too large overshoots and diverges, while one too small crawls. Batch gradient descent uses the whole dataset per step, stochastic gradient descent uses one example at a time for noisy but fast updates, and mini-batch strikes a balance and is the standard for training neural networks. Momentum and adaptive methods like Adam accelerate convergence.
