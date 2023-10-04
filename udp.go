// UDP is a package that provides functionality for handling UDP traffic over TCP connections.
package main

import (
	"log"
	"net"
)

var (
	activeTunnels    = make(map[string]chan []byte)
	udpToTCPChannels = make(map[string]chan []byte)
)

// readFromConn reads data from a net.Conn and sends it to a channel.
func readFromConn(conn net.Conn, c chan<- []byte) {
	defer close(c) // Close the channel when done.
	buf := make([]byte, 32*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			c <- append([]byte(nil), buf[:n]...) // Send a copy of the slice.
		}
		if err != nil {
			log.Printf("Connection closed: %v--->%v\r\n", conn.LocalAddr(), conn.RemoteAddr())
			return
		}
	}
}

// handleUDPOverTCP handles UDP-over-TCP traffic.
func handleUDPOverTCP(conn net.Conn, destination string) {
	defer delete(activeTunnels, destination)

	writeToWebsocketChannel := make(chan []byte)
	activeTunnels[destination] = writeToWebsocketChannel

	wsReadDataChan := make(chan []byte)
	go readFromConn(conn, wsReadDataChan)

	for {
		select {
		case dataFromWS := <-wsReadDataChan:
			if dataFromWS == nil || len(dataFromWS) < 8 {
				return
			}
			if udpWriteChan, err := getOrCreateUDPChan(destination, string(dataFromWS[:8])); err == nil {
				udpWriteChan <- dataFromWS
			} else {
				log.Printf("Unable to create connection to destination network: %v\r\n", err)
			}
		case dataFromUDP := <-activeTunnels[destination]:
			if dataFromUDP != nil {
				_, err := conn.Write(dataFromUDP)
				if err != nil {
					log.Printf("Unable to write on destination network: %v\r\n", err)
					return
				}
			}
		}
	}
}

// getOrCreateUDPChan returns an existing UDP channel or creates a new one.
func getOrCreateUDPChan(destination, header string) (chan []byte, error) {
	channelID := destination + header
	if udpWriteChan, ok := udpToTCPChannels[channelID]; ok {
		return udpWriteChan, nil
	}

	udpConn, err := net.Dial("udp", destination)
	if err != nil {
		return nil, err
	}

	udpToTCPChannels[channelID] = make(chan []byte)
	udpReadChanFromConn := make(chan []byte)
	go readFromConn(udpConn, udpReadChanFromConn)

	go func() {
		defer func() {
			delete(udpToTCPChannels, channelID)
			_ = udpConn.Close()
		}()
		for {
			select {
			case dataFromWS := <-udpToTCPChannels[channelID]:
				if len(dataFromWS) < 8 {
					return
				}
				_, err := udpConn.Write(dataFromWS[8:])
				if err != nil {
					return
				}
			case dataFromUDP := <-udpReadChanFromConn:
				if dataFromUDP == nil {
					return
				}
				if c, ok := activeTunnels[destination]; ok {
					c <- append([]byte(header[6:]), dataFromUDP...)
				}
			}
		}
	}()

	return udpToTCPChannels[channelID], nil
}
