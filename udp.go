// UDP is a package that provides functionality for handling UDP traffic over TCP connections.
package main

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"time"
)

var (
	activeTunnels    = make(map[string]chan []byte)
	udpToTCPChannels = make(map[string]chan []byte)
)

// readFromConn reads data from a net.Conn and sends it to a channel.
func readFromConn(l *slog.Logger, conn net.Conn, c chan<- []byte) {
	defer conn.Close()
	defer close(c) // Close the channel when done.
	buf := make([]byte, 2048)
	for {
		if err := conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
			return
		}

		n, err := conn.Read(buf)
		if err != nil && errors.Is(err, io.EOF) {
			return
		}

		if err != nil {
			l.Debug("connection closed", "protocol", "udp", "address", conn.RemoteAddr(), "error", err.Error())
			return
		}

		if n > 0 {
			c <- append([]byte(nil), buf[:n]...) // Send a copy of the slice.
		}
	}
}

// handleUDPOverTCP handles UDP-over-TCP traffic.
func handleUDPOverTCP(l *slog.Logger, conn net.Conn, destination string) {
	// On return, delete the destination from the map of active tunnels
	defer delete(activeTunnels, destination)

	// Store a byte channel in the map of active tunnels. The data read
	// from the UDP socket is sent on this channel.
	activeTunnels[destination] = make(chan []byte)

	wsReadDataChan := make(chan []byte)
	go readFromConn(l, conn, wsReadDataChan)

	for {
		select {
		case dataFromWS := <-wsReadDataChan:
			if dataFromWS == nil || len(dataFromWS) < 8 {
				return
			}

			udpWriteChan, err := getOrCreateUDPChan(l, destination, string(dataFromWS[:8]))
			if err != nil {
				l.Debug("unable to connect to destination", "protocol", "udp", "address", destination, "error", err.Error())
				continue
			}

			udpWriteChan <- dataFromWS

		case dataFromUDP := <-activeTunnels[destination]:
			if dataFromUDP == nil {
				continue
			}

			if err := conn.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
					return
				}

			if _, err := conn.Write(dataFromUDP); err != nil {
				l.Debug("can't write to socket", "protocol", "udp", "address", destination, "error", err.Error())
				return
			}
		}
	}
}

// getOrCreateUDPChan returns an existing UDP channel or creates a new one.
func getOrCreateUDPChan(l *slog.Logger, destination, header string) (chan []byte, error) {
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
	go readFromConn(l, udpConn, udpReadChanFromConn)

	go func() {
		defer func() {
			delete(udpToTCPChannels, channelID)
			udpConn.Close()
		}()

		for {
			select {
			case dataFromWS := <-udpToTCPChannels[channelID]:
				if len(dataFromWS) < 8 {
					return
				}

				if err := udpConn.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
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
