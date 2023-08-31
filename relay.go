package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"slices"
	"strings"
)

var torrentTrackers = []string{
	"93.158.213.92",
	"102.223.180.235",
	"23.134.88.6",
	"185.243.218.213",
	"208.83.20.20",
	"91.216.110.52",
	"83.146.97.90",
	"23.157.120.14",
	"185.102.219.163",
	"163.172.29.130",
	"156.234.201.18",
	"209.141.59.16",
	"34.94.213.23",
	"192.3.165.191",
	"130.61.55.93",
	"109.201.134.183",
	"95.31.11.224",
	"83.102.180.21",
	"192.95.46.115",
	"198.100.149.66",
	"95.216.74.39",
	"51.68.174.87",
	"37.187.111.136",
	"51.15.79.209",
	"45.92.156.182",
	"49.12.76.8",
	"5.196.89.204",
	"62.233.57.13",
	"45.9.60.30",
	"35.227.12.84",
	"179.43.155.30",
	"94.243.222.100",
	"207.241.231.226",
	"207.241.226.111",
	"51.159.54.68",
	"82.65.115.10",
	"95.217.167.10",
	"86.57.161.157",
	"83.31.30.230",
	"94.103.87.87",
	"160.119.252.41",
	"193.42.111.57",
	"80.240.22.46",
	"107.189.31.134",
	"104.244.79.114",
	"85.239.33.28",
	"61.222.178.254",
	"38.7.201.142",
	"51.81.222.188",
	"103.196.36.31",
	"23.153.248.2",
	"73.170.204.100",
	"176.31.250.174",
	"149.56.179.233",
	"212.237.53.230",
	"185.68.21.244",
	"82.156.24.219",
	"216.201.9.155",
	"51.15.41.46",
	"85.206.172.159",
	"104.244.77.87",
	"37.27.4.53",
	"192.3.165.198",
	"15.204.205.14",
	"103.122.21.50",
	"104.131.98.232",
	"173.249.201.201",
	"23.254.228.89",
	"5.102.159.190",
	"65.130.205.148",
	"119.28.71.45",
	"159.69.65.157",
	"160.251.78.190",
	"107.189.7.143",
	"159.65.224.91",
	"185.217.199.21",
	"91.224.92.110",
	"161.97.67.210",
	"51.15.3.74",
	"209.126.11.233",
	"37.187.95.112",
	"167.99.185.219",
	"144.91.88.22",
	"88.99.2.212",
	"37.59.48.81",
	"95.179.130.187",
	"51.15.26.25",
	"192.9.228.30",
}

func checkIfDestinationIsBlocked(ipAddress string) bool {
	if slices.Contains(torrentTrackers, ipAddress) {
		return true
	}
	return false
}

var cfRanges = []string{
	"127.0.0.0/8",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"104.16.0.0/12",
	"108.162.192.0/18",
	"131.0.72.0/22",
	"141.101.64.0/18",
	"162.158.0.0/15",
	"172.64.0.0/13",
	"173.245.48.0/20",
	"188.114.96.0/20",
	"190.93.240.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"::1/128",
	"2400:cb00::/32",
	"2405:8100::/32",
	"2405:b500::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2c0f:f248::/32",
	"2a06:98c0::/29",
}

var ipRange []*net.IPNet

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

func checkIfSourceIsAllowed(ipAddress string) bool {
	for _, r := range ipRange {
		ip := net.ParseIP(ipAddress)

		if r.Contains(ip) {
			return true
		}
	}

	return false
}

func init() {
	ipRange = []*net.IPNet{}

	for _, r := range cfRanges {
		_, cidr, err := net.ParseCIDR(r)
		if err != nil {
			continue
		}
		ipRange = append(ipRange, cidr)
	}
}

// Run ...
func (server *Server) Run() {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%s", server.host, server.port))
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Fatal(err)
		}

		ip := conn.RemoteAddr().String()
		sh, sp, err := net.SplitHostPort(ip)
		if err != nil {
			fmt.Println(fmt.Errorf("unable to parse host %s", ip))
			_ = conn.Close()
			continue
		}
		if !checkIfSourceIsAllowed(sh) {
			fmt.Println(fmt.Errorf("request from unacceptable source blocked: %s:%s", sh, sp))
			_ = conn.Close()
			continue
		}

		client := &Client{
			conn: conn,
		}
		go client.handleRequest()
	}
}

func (client *Client) handleRequest() {
	defer func() {
		_ = client.conn.Close()
	}()
	reader := bufio.NewReader(client.conn)
	header, err := reader.ReadBytes(byte(13))
	if len(header) < 1 {
		return
	}
	inputHeader := strings.Split(string(header[:len(header)-1]), "@")
	if len(inputHeader) < 2 {
		return
	}
	network := "tcp"
	if inputHeader[0] == "udp" {
		network = "udp"
	}
	address := strings.Replace(inputHeader[1], "$", ":", -1)
	if strings.Contains(address, "temp-mail.org") {
		return
	}

	dh, _, err := net.SplitHostPort(address)
	if err != nil {
		return
	}
	// check if ip is not blocked
	blockFlag := false
	addr := net.ParseIP(dh)
	if addr != nil {
		if checkIfDestinationIsBlocked(dh) {
			blockFlag = true
		}
	} else {
		ips, _ := net.LookupIP(dh)
		for _, ip := range ips {
			if ipv4 := ip.To4(); ipv4 != nil {
				if checkIfDestinationIsBlocked(ipv4.String()) {
					blockFlag = true
				}
			}
		}
	}

	if blockFlag {
		log.Println(fmt.Errorf("destination host is blocked: %s", address))
		return
	}

	if network == "udp" {
		handleUDPOverTCP(client.conn, address)
		return
	}

	// transmit data
	log.Printf("%s Dialing to %s...\r\n", network, address)

	rConn, err := net.Dial(network, address)

	if err != nil {
		log.Println(fmt.Errorf("failed to connect to socket: %v", err))
		return
	}

	// transmit data
	go Copy(client.conn, rConn)
	Copy(rConn, client.conn)

	_ = rConn.Close()
}

func Copy(src io.Reader, dst io.Writer) {
	buf := make([]byte, 256*1024)

	_, err := io.CopyBuffer(dst, src, buf[:cap(buf)])
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
