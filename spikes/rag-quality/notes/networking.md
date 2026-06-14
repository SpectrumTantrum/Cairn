# Computer Networking

## TCP versus UDP

TCP, the Transmission Control Protocol, is connection-oriented and reliable: it establishes a connection with a three-way handshake, numbers every byte, retransmits lost segments, and delivers data in order to the application. UDP, the User Datagram Protocol, is connectionless and unreliable, firing off datagrams with no handshake, no retransmission, and no ordering guarantee. The trade-off is latency versus reliability: TCP suits file transfer and web pages where correctness matters, while UDP suits live video, gaming, and DNS where a late packet is worse than a lost one.

## The TCP Three-Way Handshake

A TCP connection opens with a three-way handshake. The client sends a SYN segment with an initial sequence number, the server replies with a SYN-ACK acknowledging the client's number and supplying its own, and the client returns an ACK. After these three messages both sides have agreed on starting sequence numbers and the connection is established. Closing is a separate four-way exchange of FIN and ACK segments because each direction of the connection is shut down independently.

## The OSI and TCP/IP Models

The OSI model layers networking into seven abstractions: physical, data link, network, transport, session, presentation, and application. The more practical TCP/IP model collapses these into four: link, internet, transport, and application. Layering lets each level depend only on the service the layer below provides — the transport layer does not care whether the link below is Ethernet or Wi-Fi. IP lives at the internet layer and routes packets between networks, while TCP and UDP live at the transport layer above it.

## DNS Resolution

The Domain Name System translates human-readable hostnames into IP addresses through a hierarchy of servers. A resolver first checks its cache, then queries a root server, which directs it to the top-level-domain server for the suffix such as dot-com, which in turn points to the authoritative server for the specific domain. The authoritative server returns the address record. Caching with time-to-live values throughout the hierarchy keeps the common case fast and avoids hammering the root servers for every lookup.
