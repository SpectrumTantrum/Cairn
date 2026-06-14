# Computer Security Basics

## Symmetric versus Asymmetric Encryption

Symmetric encryption uses one shared secret key for both encrypting and decrypting, which makes it fast and suited to bulk data, but both parties must somehow already share the key. Asymmetric encryption uses a public key to encrypt and a mathematically linked private key to decrypt, so anyone can send a secret to the holder of the private key without a prior shared secret. In practice systems combine the two: asymmetric cryptography securely exchanges a fresh symmetric key, then the fast symmetric cipher protects the actual traffic.

## Hashing and Password Storage

A password should never be stored in plaintext. Instead the system stores a salted hash: it appends a unique random salt to the password and runs it through a slow password-hashing function such as bcrypt, scrypt, or Argon2. The salt defeats precomputed rainbow tables by making identical passwords hash differently, and the deliberate slowness throttles brute-force guessing. At login the system hashes the entered password with the stored salt and compares digests, never recovering the original password.

## Common Web Vulnerabilities

SQL injection happens when untrusted input is concatenated into a query, letting an attacker alter the query's structure; parameterized queries are the fix. Cross-site scripting injects attacker script into a page so it runs in another user's browser, defeated by escaping output and a content security policy. Cross-site request forgery tricks an authenticated browser into making an unwanted request, blocked by anti-forgery tokens. The recurring lesson is to treat all input as hostile and to separate code from data.

## Authentication versus Authorization

Authentication answers who you are by verifying a credential such as a password, a hardware key, or a biometric, often strengthened by combining factors. Authorization answers what you are allowed to do once your identity is established, typically through roles or access-control lists. The two are distinct: a system can authenticate a user perfectly and still deny an action they lack permission for. Confusing the two leads to broken access control, consistently one of the most common security flaws.
