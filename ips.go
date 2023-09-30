package main

import (
	"net/netip"

	"github.com/gaissmai/cidrtree"
)

var (
	// List of torrent trackers
	torrentTrackers = []netip.Prefix{
		netip.MustParsePrefix("93.158.213.92/32"),
		netip.MustParsePrefix("102.223.180.235/32"),
		netip.MustParsePrefix("23.134.88.6/32"),
		netip.MustParsePrefix("185.243.218.213/32"),
		netip.MustParsePrefix("208.83.20.20/32"),
		netip.MustParsePrefix("91.216.110.52/32"),
		netip.MustParsePrefix("83.146.97.90/32"),
		netip.MustParsePrefix("23.157.120.14/32"),
		netip.MustParsePrefix("185.102.219.163/32"),
		netip.MustParsePrefix("163.172.29.130/32"),
		netip.MustParsePrefix("156.234.201.18/32"),
		netip.MustParsePrefix("209.141.59.16/32"),
		netip.MustParsePrefix("34.94.213.23/32"),
		netip.MustParsePrefix("192.3.165.191/32"),
		netip.MustParsePrefix("130.61.55.93/32"),
		netip.MustParsePrefix("109.201.134.183/32"),
		netip.MustParsePrefix("95.31.11.224/32"),
		netip.MustParsePrefix("83.102.180.21/32"),
		netip.MustParsePrefix("192.95.46.115/32"),
		netip.MustParsePrefix("198.100.149.66/32"),
		netip.MustParsePrefix("95.216.74.39/32"),
		netip.MustParsePrefix("51.68.174.87/32"),
		netip.MustParsePrefix("37.187.111.136/32"),
		netip.MustParsePrefix("51.15.79.209/32"),
		netip.MustParsePrefix("45.92.156.182/32"),
		netip.MustParsePrefix("49.12.76.8/32"),
		netip.MustParsePrefix("5.196.89.204/32"),
		netip.MustParsePrefix("62.233.57.13/32"),
		netip.MustParsePrefix("45.9.60.30/32"),
		netip.MustParsePrefix("35.227.12.84/32"),
		netip.MustParsePrefix("179.43.155.30/32"),
		netip.MustParsePrefix("94.243.222.100/32"),
		netip.MustParsePrefix("207.241.231.226/32"),
		netip.MustParsePrefix("207.241.226.111/32"),
		netip.MustParsePrefix("51.159.54.68/32"),
		netip.MustParsePrefix("82.65.115.10/32"),
		netip.MustParsePrefix("95.217.167.10/32"),
		netip.MustParsePrefix("86.57.161.157/32"),
		netip.MustParsePrefix("83.31.30.230/32"),
		netip.MustParsePrefix("94.103.87.87/32"),
		netip.MustParsePrefix("160.119.252.41/32"),
		netip.MustParsePrefix("193.42.111.57/32"),
		netip.MustParsePrefix("80.240.22.46/32"),
		netip.MustParsePrefix("107.189.31.134/32"),
		netip.MustParsePrefix("104.244.79.114/32"),
		netip.MustParsePrefix("85.239.33.28/32"),
		netip.MustParsePrefix("61.222.178.254/32"),
		netip.MustParsePrefix("38.7.201.142/32"),
		netip.MustParsePrefix("51.81.222.188/32"),
		netip.MustParsePrefix("103.196.36.31/32"),
		netip.MustParsePrefix("23.153.248.2/32"),
		netip.MustParsePrefix("73.170.204.100/32"),
		netip.MustParsePrefix("176.31.250.174/32"),
		netip.MustParsePrefix("149.56.179.233/32"),
		netip.MustParsePrefix("212.237.53.230/32"),
		netip.MustParsePrefix("185.68.21.244/32"),
		netip.MustParsePrefix("82.156.24.219/32"),
		netip.MustParsePrefix("216.201.9.155/32"),
		netip.MustParsePrefix("51.15.41.46/32"),
		netip.MustParsePrefix("85.206.172.159/32"),
		netip.MustParsePrefix("104.244.77.87/32"),
		netip.MustParsePrefix("37.27.4.53/32"),
		netip.MustParsePrefix("192.3.165.198/32"),
		netip.MustParsePrefix("15.204.205.14/32"),
		netip.MustParsePrefix("103.122.21.50/32"),
		netip.MustParsePrefix("104.131.98.232/32"),
		netip.MustParsePrefix("173.249.201.201/32"),
		netip.MustParsePrefix("23.254.228.89/32"),
		netip.MustParsePrefix("5.102.159.190/32"),
		netip.MustParsePrefix("65.130.205.148/32"),
		netip.MustParsePrefix("119.28.71.45/32"),
		netip.MustParsePrefix("159.69.65.157/32"),
		netip.MustParsePrefix("160.251.78.190/32"),
		netip.MustParsePrefix("107.189.7.143/32"),
		netip.MustParsePrefix("159.65.224.91/32"),
		netip.MustParsePrefix("185.217.199.21/32"),
		netip.MustParsePrefix("91.224.92.110/32"),
		netip.MustParsePrefix("161.97.67.210/32"),
		netip.MustParsePrefix("51.15.3.74/32"),
		netip.MustParsePrefix("209.126.11.233/32"),
		netip.MustParsePrefix("37.187.95.112/32"),
		netip.MustParsePrefix("167.99.185.219/32"),
		netip.MustParsePrefix("144.91.88.22/32"),
		netip.MustParsePrefix("88.99.2.212/32"),
		netip.MustParsePrefix("37.59.48.81/32"),
		netip.MustParsePrefix("95.179.130.187/32"),
		netip.MustParsePrefix("51.15.26.25/32"),
		netip.MustParsePrefix("192.9.228.30/32"),
	}

	// List of Cloudflare IP ranges
	cfRanges = []netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("103.21.244.0/22"),
		netip.MustParsePrefix("103.22.200.0/22"),
		netip.MustParsePrefix("103.31.4.0/22"),
		netip.MustParsePrefix("104.16.0.0/12"),
		netip.MustParsePrefix("108.162.192.0/18"),
		netip.MustParsePrefix("131.0.72.0/22"),
		netip.MustParsePrefix("141.101.64.0/18"),
		netip.MustParsePrefix("162.158.0.0/15"),
		netip.MustParsePrefix("172.64.0.0/13"),
		netip.MustParsePrefix("173.245.48.0/20"),
		netip.MustParsePrefix("188.114.96.0/20"),
		netip.MustParsePrefix("190.93.240.0/20"),
		netip.MustParsePrefix("197.234.240.0/22"),
		netip.MustParsePrefix("198.41.128.0/17"),
		netip.MustParsePrefix("::1/128"),
		netip.MustParsePrefix("2400:cb00::/32"),
		netip.MustParsePrefix("2405:8100::/32"),
		netip.MustParsePrefix("2405:b500::/32"),
		netip.MustParsePrefix("2606:4700::/32"),
		netip.MustParsePrefix("2803:f800::/32"),
		netip.MustParsePrefix("2c0f:f248::/32"),
		netip.MustParsePrefix("2a06:98c0::/29"),
	}

	connFilter = NewFilter()
)

type filter struct {
	sourceWhitelist      cidrtree.Tree
	destinationBlacklist cidrtree.Tree
}

func NewFilter() *filter {
	// Generate the Source IP whitelist
	srcWhitelist := cidrtree.New(cfRanges...)

	// Generate the destination IP blacklist
	destBlacklist := cidrtree.New(torrentTrackers...)

	return &filter{
		sourceWhitelist:      srcWhitelist,
		destinationBlacklist: destBlacklist,
	}
}

func (f *filter) isSourceAllowed(addr netip.Addr) bool {
	_, found := f.sourceWhitelist.Lookup(addr)
	return found
}

func (f *filter) isDestinationAllowed(addr netip.Addr) bool {
	_, found := f.destinationBlacklist.Lookup(addr)
	return !found
}
