package main

import "net"

func handleTCP(lConn, rConn net.Conn) {
	go Copy(lConn, rConn)
	Copy(rConn, lConn)
}
