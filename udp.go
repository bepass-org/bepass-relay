package main

import (
	"fmt"
	"log"
	"net"
)

var (
	activeTunnels    = make(map[string]chan []byte)
	udpToTCPChannels = make(map[string]chan []byte)
)

func chanFromConn(conn net.Conn) chan []byte {
	c := make(chan []byte)

	go func() {
		b := make([]byte, 32*1024)

		for {
			n, err := conn.Read(b)
			if n > 0 {
				c <- b[:n]
			}
			if err != nil {
				log.Printf("Connection closed: %v--->%v\r\n", conn.LocalAddr(), conn.RemoteAddr())
				c <- nil
				break
			}
		}
	}()

	return c
}

func handleUDPOverTCP(conn net.Conn, destination string) {
	writeToWebsocketChannel := make(chan []byte)
	activeTunnels[destination] = writeToWebsocketChannel

	wsReadDataChan := chanFromConn(conn)

	defer delete(activeTunnels, destination)
	for {
		select {
		case dataThatReceivedFromWebsocket := <-wsReadDataChan:
			if dataThatReceivedFromWebsocket == nil {
				return
			} else {
				c, err := getOrCreateUDPChanFromWebSocketPacket(dataThatReceivedFromWebsocket, destination)
				if err == nil {
					c <- dataThatReceivedFromWebsocket
				} else {
					log.Printf("unable to create connection to destination network: %v\r\n", err)
				}
			}
		case dataThatReceivedFromUDPChan := <-activeTunnels[destination]:
			// it never is null
			if dataThatReceivedFromUDPChan != nil {
				_, err := conn.Write(dataThatReceivedFromUDPChan)
				if err != nil {
					log.Printf("unable to write on destination network: %v\r\n", err)
					return
				}
			}
		}
	}
}

func getOrCreateUDPChanFromWebSocketPacket(packet []byte, destination string) (chan []byte, error) {
	// the first 8 byte of each packet is user random id(6bytes) + channel id(2bytes)
	if len(packet) < 8 {
		return nil, fmt.Errorf("too small packet")
	}
	packetHeader := packet[:8]
	channelID := destination + string(packetHeader)
	if udpWriteChan, ok := udpToTCPChannels[channelID]; ok {
		return udpWriteChan, nil
	}
	udpConn, err := net.Dial("udp", destination)
	if err != nil {
		return nil, err
	}
	udpToTCPChannels[channelID] = make(chan []byte)
	udpReadChanFromConn := chanFromConn(udpConn)
	go func() {
		for {
			select {
			case dataThatReceivedFromWebsocketThroughChannel := <-udpToTCPChannels[channelID]:
				_, err := udpConn.Write(dataThatReceivedFromWebsocketThroughChannel[8:])
				if err != nil {
					delete(udpToTCPChannels, channelID)
					return
				}
			case dataThatReceivedFromUDPReadChan := <-udpReadChanFromConn:
				if dataThatReceivedFromUDPReadChan == nil {
					delete(udpToTCPChannels, channelID)
					return
				}
				if c, ok := activeTunnels[destination]; ok {
					// no need to send userid
					c <- append(packetHeader[6:], dataThatReceivedFromUDPReadChan...)
				}
			}
		}
	}()
	return udpToTCPChannels[channelID], nil
}
