package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
)

// Server ...
type Server struct {
	host string
	port string
}

// Client ...
type Client struct {
	conn net.Conn
}

// Config ...
type Config struct {
	Host string
	Port string
}

// New ...
func New(config *Config) *Server {
	return &Server{
		host: config.Host,
		port: config.Port,
	}
}

// Run ...
func (server *Server) Run() {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%s", server.host, server.port))
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Fatal(err)
		}

		client := &Client{
			conn: conn,
		}
		go client.handleRequest()
	}
}

func (client *Client) handleRequest() {
	reader := bufio.NewReader(client.conn)
	header, _ := reader.ReadBytes(byte(13))
	if len(header) < 1 {
		return
	}
	address := strings.Replace(string(header[:len(header)-1]), "$", ":", -1)
	fmt.Printf("Dialing to %s...\r\n", address)
	rConn, err := net.Dial("tcp", address)
	if err != nil {
		fmt.Println(fmt.Errorf("failed to connect to socket: %v", err))
		return
	}

	// transmit data
	go Copy(client.conn, rConn)
	Copy(rConn, client.conn)

	_ = rConn.Close()
}

func Copy(reader io.Reader, writer io.Writer) {
	buf := make([]byte, 256*1024)

	_, err := io.CopyBuffer(writer, reader, buf[:cap(buf)])
	if err != nil {
		fmt.Println(err)
	}
}

func main() {
	var ip string
	var port string
	flag.StringVar(&ip, "b", "0.0.0.0", "Server IP address")
	flag.StringVar(&port, "p", "6666", "Server Port number")
	flag.Parse()
	server := New(&Config{
		Host: ip,
		Port: port,
	})
	server.Run()
}
