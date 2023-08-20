/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
// @ts-ignore
import { connect } from 'cloudflare:sockets';

const proxyIPs = ['x.x.x.x'];
const proxyPort = 6666;
let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const cf_ipv4 = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
]

const cf_ipv6 = [
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
]


export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        switch (url.pathname) {
            case '/dns-query':
                url.hostname = "8.8.8.8"
                return await fetch(url.toString());
            case '/connect': // for test connect to cf socket
                return await bepassOverWs(request)
            default:
                return new Response("{status: 'functions normally'}", {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json;charset=utf-8",
                    },
                });
        }
    },
};

async function bepassOverWs(request) {
    const params = {}
    const url = new URL(request.url)
    const queryString = url.search.slice(1).split('&')

    queryString.forEach(item => {
        const kv = item.split('=')
        if (kv[0]) params[kv[0]] = kv[1] || true
    })

    const destinationHost = params["host"]
    const destinationPort = params["port"]

    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();

    let address = '';
    let portWithRandomLog = '';
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };

    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, log);

    let remoteSocketWapper = {
        value: null,
    };

    // ws --> remote
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter()
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            handleTCPOutBound(remoteSocketWapper, destinationHost, destinationPort, chunk, webSocket, log);
        },
        close() {
            log(`readableWebSocketStream is close`);
        },
        abort(reason) {
            log(`readableWebSocketStream is abort`, JSON.stringify(reason));
        },
    })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
    });

    return new Response(null, {
        status: 101,
        // @ts-ignore
        webSocket: client,
    });
}

function makeReadableWebSocketStream(webSocketServer, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) {
                    return;
                }
                const message = event.data;
                controller.enqueue(message);
            });

            // The event means that the client closed the client -> server stream.
            // However, the server -> client stream is still open until you call close() on the server side.
            // The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
            webSocketServer.addEventListener('close', () => {
                    // client send close, need close server
                    // if stream is cancel, skip controller.close
                    safeCloseWebSocket(webSocketServer);
                    if (readableStreamCancel) {
                        return;
                    }
                    controller.close();
                }
            );
            webSocketServer.addEventListener('error', (err) => {
                    log('webSocketServer has error');
                    controller.error(err);
                }
            );
        },
        cancel(reason) {
            // 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
            // 2. if readableStream is cancel, all controller.close/enqueue need skip,
            // 3. but from testing controller.error still work even if readableStream is cancel
            if (readableStreamCancel) {
                return;
            }
            log(`ReadableStream was canceled, due to ${reason}`)
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });

    return stream;
}

function longToByteArray(long) {
    // we want to represent the input as a 2-bytes array
    const byteArray = [0, 0];

    for ( let index = 0; index < byteArray.length; index ++ ) {
        const byte = long & 0xff;
        byteArray [ index ] = byte;
        long = (long - byte) / 256 ;
    }

    return byteArray;
};

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, log,) {
    async function connectAndWrite(address, port, rawHeaderEnabled) {
        const mmd = addressRemote + "$" + portRemote
        if(!rawHeaderEnabled && isIP(address) && (inRange(address, cf_ipv6) || inRange(address, cf_ipv4))){
            rawHeaderEnabled = true;
        }
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        if(rawHeaderEnabled){
            const writer = tcpSocket.writable.getWriter();
            try {
                const header = new TextEncoder().encode(mmd + "\r\n");
                await writer.write(header);
            } catch (writeError) {
                writer.releaseLock();
                await tcpSocket.close();
                return new Response(writeError.message, { status: 500 });
            }
            writer.releaseLock();
        }
        return tcpSocket;
    }

    // if the cf connect tcp socket have no incoming data, we retry to redirect ip
    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP, proxyPort, true)
        // no matter retry success or not, close websocket
        tcpSocket.closed.catch(error => {
            console.log('retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        })
        remoteSocketToWS(tcpSocket, webSocket, null, log);
    }

    const tcpSocket = await connectAndWrite(addressRemote, portRemote, false);

    // when remoteSocket is ready, pass to websocket
    // remote--> ws
    remoteSocketToWS(tcpSocket, webSocket, retry, log);
}

async function remoteSocketToWS(remoteSocket, webSocket, retry, log) {
    // remote--> ws
    let remoteChunkCount = 0;
    let chunks = [];
    let hasIncomingData = false; // check if remoteSocket has incoming data
    await remoteSocket.readable
        .pipeTo(
            new WritableStream({
                start() {
                },
                async write(chunk, controller) {
                    hasIncomingData = true;
                    // remoteChunkCount++;
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        controller.error(
                            'webSocket.readyState is not open, maybe close'
                        );
                    }
                    // seems no need rate limit this, CF seems fix this??..
                    // if (remoteChunkCount > 20000) {
                    // 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
                    // 	await delay(1);
                    // }
                    webSocket.send(chunk);
                },
                close() {
                    log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
                    // safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
                },
                abort(reason) {
                    console.error(`remoteConnection!.readable abort`, reason);
                },
            })
        )
        .catch((error) => {
            console.error(
                `remoteSocketToWS has exception `,
                error.stack || error
            );
            safeCloseWebSocket(webSocket);
        });

    // seems is cf connect socket have error,
    // 1. Socket.closed will have error
    // 2. Socket.readable will be close without any data coming
    if (hasIncomingData === false && retry) {
        log(`retry`)
        retry();
    }
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

const normalize = function (a) {
    validate(a);

    a = a.toLowerCase()

    const nh = a.split(/\:\:/g);
    if (nh.length > 2) {
        throw new Error('Invalid address: ' + a);
    }

    let sections = [];
    if (nh.length === 1) {
        // full mode
        sections = a.split(/\:/g);
        if (sections.length !== 8) {
            throw new Error('Invalid address: ' + a);
        }
    } else if (nh.length === 2) {
        // compact mode
        const n = nh[0];
        const h = nh[1];
        const ns = n.split(/\:/g);
        const hs = h.split(/\:/g);
        for (let i in ns) {
            sections[i] = ns[i];
        }
        for (let i = hs.length; i > 0; --i) {
            sections[7 - (hs.length - i)] = hs[i - 1];
        }
    }
    for (let i = 0; i < 8; ++i) {
        if (sections[i] === undefined) {
            sections[i] = '0000';
        }
        sections[i] = _leftPad(sections[i], '0', 4);
    }
    return sections.join(':');
};

const abbreviate = function (a) {
    validate(a);
    a = normalize(a);
    a = a.replace(/0000/g, 'g');
    a = a.replace(/\:000/g, ':');
    a = a.replace(/\:00/g, ':');
    a = a.replace(/\:0/g, ':');
    a = a.replace(/g/g, '0');
    const sections = a.split(/\:/g);
    let zPreviousFlag = false;
    let zeroStartIndex = -1;
    let zeroLength = 0;
    let zStartIndex = -1;
    let zLength = 0;
    for (let i = 0; i < 8; ++i) {
        const section = sections[i];
        let zFlag = (section === '0');
        if (zFlag && !zPreviousFlag) {
            zStartIndex = i;
        }
        if (!zFlag && zPreviousFlag) {
            zLength = i - zStartIndex;
        }
        if (zLength > 1 && zLength > zeroLength) {
            zeroStartIndex = zStartIndex;
            zeroLength = zLength;
        }
        zPreviousFlag = (section === '0');
    }
    if (zPreviousFlag) {
        zLength = 8 - zStartIndex;
    }
    if (zLength > 1 && zLength > zeroLength) {
        zeroStartIndex = zStartIndex;
        zeroLength = zLength;
    }
    //console.log(zeroStartIndex, zeroLength);
    //console.log(sections);
    if (zeroStartIndex >= 0 && zeroLength > 1) {
        sections.splice(zeroStartIndex, zeroLength, 'g');
    }
    //console.log(sections);
    a = sections.join(':');
    //console.log(a);
    a = a.replace(/\:g\:/g, '::');
    a = a.replace(/\:g/g, '::');
    a = a.replace(/g\:/g, '::');
    a = a.replace(/g/g, '::');
    //console.log(a);
    return a;
};

// Basic validation
const validate = function (a) {
    const ns = [];
    const nh = a.split('::');
    if (nh.length > 2) {
        throw new Error('Invalid address: ' + a);
    } else if (nh.length === 2) {
        if (nh[0].startsWith(':') || nh[0].endsWith(':') || nh[1].startsWith(':') || nh[1].endsWith(':')) {
            throw new Error('Invalid address: ' + a);
        }

        ns.push(... (nh[0].split(':').filter(a => a)));
        ns.push(... (nh[1].split(':').filter(a => a)));
        if (ns.length > 7) {
            throw new Error('Invalid address: ' + a);
        }
    } else if (nh.length === 1) {
        ns.push(... (nh[0].split(':').filter(a => a)));
        if (ns.length !== 8) {
            throw new Error('Invalid address: ' + a);
        }
    }

    for (const n of ns) {
        const match = n.match(/^[a-f0-9]{1,4}$/i);
        if (match?.[0] !== n) {
            throw new Error('Invalid address: ' + a);
        }
    }
};

const _leftPad = function (d, p, n) {
    const padding = p.repeat(n);
    if (d.length < padding.length) {
        d = padding.substring(0, padding.length - d.length) + d;
    }
    return d;
};

const _hex2bin = function (hex) {
    return parseInt(hex, 16).toString(2)
};
const _bin2hex = function (bin) {
    return parseInt(bin, 2).toString(16)
};

const _addr2bin = function (addr) {
    const nAddr = normalize(addr);
    const sections = nAddr.split(":");
    let binAddr = '';
    for (const section of sections) {
        binAddr += _leftPad(_hex2bin(section), '0', 16);
    }
    return binAddr;
};

const _bin2addr = function (bin) {
    const addr = [];
    for (let i = 0; i < 8; ++i) {
        const binPart = bin.substr(i * 16, 16);
        const hexSection = _leftPad(_bin2hex(binPart), '0', 4);
        addr.push(hexSection);
    }
    return addr.join(':');
};

const divideSubnet = function (addr, mask0, mask1, limit, abbr) {
    validate(addr);
    mask0 *= 1;
    mask1 *= 1;
    limit *= 1;
    mask1 = mask1 || 128;
    if (mask0 < 0 || mask1 < 0 || mask0 > 128 || mask1 > 128 || mask0 > mask1) {
        throw new Error('Invalid masks.');
    }
    const ret = [];
    const binAddr = _addr2bin(addr);
    const binNetPart = binAddr.substr(0, mask0);
    const binHostPart = '0'.repeat(128 - mask1);
    const numSubnets = Math.pow(2, mask1 - mask0);
    for (let i = 0; i < numSubnets; ++i) {
        if (!!limit && i >= limit) {
            break;
        }
        const binSubnet = _leftPad(i.toString(2), '0', mask1 - mask0);
        const binSubAddr = binNetPart + binSubnet + binHostPart;
        const hexAddr = _bin2addr(binSubAddr);
        if (!!abbr) {
            ret.push(abbreviate(hexAddr));
        } else {
            ret.push(hexAddr);
        }

    }
    // console.log(numSubnets);
    // console.log(binNetPart, binSubnetPart, binHostPart);
    // console.log(binNetPart.length, binSubnetPart.length, binHostPart.length);
    // console.log(ret.length);
    return ret;
};

const range = function (addr, mask0, mask1, abbr) {
    validate(addr);
    mask0 *= 1;
    mask1 *= 1;
    mask1 = mask1 || 128;
    if (mask0 < 0 || mask1 < 0 || mask0 > 128 || mask1 > 128 || mask0 > mask1) {
        throw new Error('Invalid masks.');
    }
    const binAddr = _addr2bin(addr);
    const binNetPart = binAddr.substr(0, mask0);
    const binHostPart = '0'.repeat(128 - mask1);
    const binStartAddr = binNetPart + '0'.repeat(mask1 - mask0) + binHostPart;
    const binEndAddr = binNetPart + '1'.repeat(mask1 - mask0) + binHostPart;
    if (!!abbr) {
        return {
            start: abbreviate(_bin2addr(binStartAddr)),
            end: abbreviate(_bin2addr(binEndAddr)),
            size: Math.pow(2, mask1 - mask0)
        };
    } else {
        return {
            start: _bin2addr(binStartAddr),
            end: _bin2addr(binEndAddr),
            size: Math.pow(2, mask1 - mask0)
        };
    }
};

const rangeBigInt = function (addr, mask0, mask1, abbr) {
    if (typeof BigInt === 'undefined') {
        return range(addr, mask0, mask1, abbr);
    }

    validate(addr);
    mask0 *= 1;
    mask1 *= 1;
    mask1 = mask1 || 128;
    if (mask0 < 0 || mask1 < 0 || mask0 > 128 || mask1 > 128 || mask0 > mask1) {
        throw new Error('Invalid masks.');
    }
    const binAddr = _addr2bin(addr);
    const binNetPart = binAddr.substr(0, mask0);
    const binHostPart = '0'.repeat(128 - mask1);
    const binStartAddr = binNetPart + '0'.repeat(mask1 - mask0) + binHostPart;
    const binEndAddr = binNetPart + '1'.repeat(mask1 - mask0) + binHostPart;
    if (!!abbr) {
        return {
            start: abbreviate(_bin2addr(binStartAddr)),
            end: abbreviate(_bin2addr(binEndAddr)),
            size: BigInt(2 ** (mask1 - mask0)).toString()
        };
    } else {
        return {
            start: _bin2addr(binStartAddr),
            end: _bin2addr(binEndAddr),
            size: BigInt(2 ** (mask1 - mask0)).toString()
        };
    }
};

const randomSubnet = function (addr, mask0, mask1, limit, abbr) {
    validate(addr);
    mask0 *= 1;
    mask1 *= 1;
    limit *= 1;
    mask1 = mask1 || 128;
    limit = limit || 1;
    if (mask0 < 0 || mask1 < 0 || mask0 > 128 || mask1 > 128 || mask0 > mask1) {
        throw new Error('Invalid masks.');
    }
    const ret = [];
    const binAddr = _addr2bin(addr);
    const binNetPart = binAddr.substr(0, mask0);
    const binHostPart = '0'.repeat(128 - mask1);
    const numSubnets = Math.pow(2, mask1 - mask0);
    for (let i = 0; i < numSubnets && i < limit; ++i) {
        // generate an binary string with length of mask1 - mask0
        let binSubnet = '';
        for (let j = 0; j < mask1 - mask0; ++j) {
            binSubnet += Math.floor(Math.random() * 2);
        }
        const binSubAddr = binNetPart + binSubnet + binHostPart;
        const hexAddr = _bin2addr(binSubAddr);
        if (!!abbr) {
            ret.push(abbreviate(hexAddr));
        } else {
            ret.push(hexAddr);
        }
    }
    // console.log(numSubnets);
    // console.log(binNetPart, binSubnetPart, binHostPart);
    // console.log(binNetPart.length, binSubnetPart.length, binHostPart.length);
    // console.log(ret.length);
    return ret;
};

const ptr = function (addr, mask) {
    validate(addr);
    mask *= 1;
    if (mask < 0 || mask > 128 || Math.floor(mask / 4) != mask / 4) {
        throw new Error('Invalid masks.');
    }
    const fullAddr = normalize(addr);
    const reverse = fullAddr.replace(/:/g, '').split('').reverse();
    return reverse.slice(0, (128 - mask) / 4).join('.');
};

const ip6 = {
    normalize,
    abbreviate,
    validate,
    divideSubnet,
    range,
    rangeBigInt,
    randomSubnet,
    ptr,
};

const ipv4Part = '(0?\\d+|0x[a-f0-9]+)';
const ipv4Regexes = {
    fourOctet: new RegExp(`^${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}$`, 'i'),
    threeOctet: new RegExp(`^${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}$`, 'i'),
    twoOctet: new RegExp(`^${ipv4Part}\\.${ipv4Part}$`, 'i'),
    longValue: new RegExp(`^${ipv4Part}$`, 'i')
};

// Regular Expression for checking Octal numbers
const octalRegex = new RegExp(`^0[0-7]+$`, 'i');
const hexRegex = new RegExp(`^0x[a-f0-9]+$`, 'i');

const zoneIndex = '%[0-9a-z]{1,}';

// IPv6-matching regular expressions.
// For IPv6, the task is simpler: it is enough to match the colon-delimited
// hexadecimal IPv6 and a transitional variant with dotted-decimal IPv4 at
// the end.
const ipv6Part = '(?:[0-9a-f]+::?)+';
const ipv6Regexes = {
    zoneIndex: new RegExp(zoneIndex, 'i'),
    'native': new RegExp(`^(::)?(${ipv6Part})?([0-9a-f]+)?(::)?(${zoneIndex})?$`, 'i'),
    deprecatedTransitional: new RegExp(`^(?:::)(${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}(${zoneIndex})?)$`, 'i'),
    transitional: new RegExp(`^((?:${ipv6Part})|(?:::)(?:${ipv6Part})?)${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}\\.${ipv4Part}(${zoneIndex})?$`, 'i')
};

// Expand :: in an IPv6 address or address part consisting of `parts` groups.
function expandIPv6 (string, parts) {
    // More than one '::' means invalid adddress
    if (string.indexOf('::') !== string.lastIndexOf('::')) {
        return null;
    }

    let colonCount = 0;
    let lastColon = -1;
    let zoneId = (string.match(ipv6Regexes.zoneIndex) || [])[0];
    let replacement, replacementCount;

    // Remove zone index and save it for later
    if (zoneId) {
        zoneId = zoneId.substring(1);
        string = string.replace(/%.+$/, '');
    }

    // How many parts do we already have?
    while ((lastColon = string.indexOf(':', lastColon + 1)) >= 0) {
        colonCount++;
    }

    // 0::0 is two parts more than ::
    if (string.substr(0, 2) === '::') {
        colonCount--;
    }

    if (string.substr(-2, 2) === '::') {
        colonCount--;
    }

    // The following loop would hang if colonCount > parts
    if (colonCount > parts) {
        return null;
    }

    // replacement = ':' + '0:' * (parts - colonCount)
    replacementCount = parts - colonCount;
    replacement = ':';
    while (replacementCount--) {
        replacement += '0:';
    }

    // Insert the missing zeroes
    string = string.replace('::', replacement);

    // Trim any garbage which may be hanging around if :: was at the edge in
    // the source strin
    if (string[0] === ':') {
        string = string.slice(1);
    }

    if (string[string.length - 1] === ':') {
        string = string.slice(0, -1);
    }

    parts = (function () {
        const ref = string.split(':');
        const results = [];

        for (let i = 0; i < ref.length; i++) {
            results.push(parseInt(ref[i], 16));
        }

        return results;
    })();

    return {
        parts: parts,
        zoneId: zoneId
    };
}

// A generic CIDR (Classless Inter-Domain Routing) RFC1518 range matcher.
function matchCIDR (first, second, partSize, cidrBits) {
    if (first.length !== second.length) {
        throw new Error('ipaddr: cannot match CIDR for objects with different lengths');
    }

    let part = 0;
    let shift;

    while (cidrBits > 0) {
        shift = partSize - cidrBits;
        if (shift < 0) {
            shift = 0;
        }

        if (first[part] >> shift !== second[part] >> shift) {
            return false;
        }

        cidrBits -= partSize;
        part += 1;
    }

    return true;
}

function parseIntAuto (string) {
    // Hexadedimal base 16 (0x#)
    if (hexRegex.test(string)) {
        return parseInt(string, 16);
    }
    // While octal representation is discouraged by ECMAScript 3
    // and forbidden by ECMAScript 5, we silently allow it to
    // work only if the rest of the string has numbers less than 8.
    if (string[0] === '0' && !isNaN(parseInt(string[1], 10))) {
        if (octalRegex.test(string)) {
            return parseInt(string, 8);
        }
        throw new Error(`ipaddr: cannot parse ${string} as octal`);
    }
    // Always include the base 10 radix!
    return parseInt(string, 10);
}

function padPart (part, length) {
    while (part.length < length) {
        part = `0${part}`;
    }

    return part;
}

const ipaddr = {};

// An IPv4 address (RFC791).
ipaddr.IPv4 = (function () {
    // Constructs a new IPv4 address from an array of four octets
    // in network order (MSB first)
    // Verifies the input.
    function IPv4 (octets) {
        if (octets.length !== 4) {
            throw new Error('ipaddr: ipv4 octet count should be 4');
        }

        let i, octet;

        for (i = 0; i < octets.length; i++) {
            octet = octets[i];
            if (!((0 <= octet && octet <= 255))) {
                throw new Error('ipaddr: ipv4 octet should fit in 8 bits');
            }
        }

        this.octets = octets;
    }

    // Special IPv4 address ranges.
    // See also https://en.wikipedia.org/wiki/Reserved_IP_addresses
    IPv4.prototype.SpecialRanges = {
        unspecified: [[new IPv4([0, 0, 0, 0]), 8]],
        broadcast: [[new IPv4([255, 255, 255, 255]), 32]],
        // RFC3171
        multicast: [[new IPv4([224, 0, 0, 0]), 4]],
        // RFC3927
        linkLocal: [[new IPv4([169, 254, 0, 0]), 16]],
        // RFC5735
        loopback: [[new IPv4([127, 0, 0, 0]), 8]],
        // RFC6598
        carrierGradeNat: [[new IPv4([100, 64, 0, 0]), 10]],
        // RFC1918
        'private': [
            [new IPv4([10, 0, 0, 0]), 8],
            [new IPv4([172, 16, 0, 0]), 12],
            [new IPv4([192, 168, 0, 0]), 16]
        ],
        // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
        reserved: [
            [new IPv4([192, 0, 0, 0]), 24],
            [new IPv4([192, 0, 2, 0]), 24],
            [new IPv4([192, 88, 99, 0]), 24],
            [new IPv4([198, 18, 0, 0]), 15],
            [new IPv4([198, 51, 100, 0]), 24],
            [new IPv4([203, 0, 113, 0]), 24],
            [new IPv4([240, 0, 0, 0]), 4]
        ]
    };

    // The 'kind' method exists on both IPv4 and IPv6 classes.
    IPv4.prototype.kind = function () {
        return 'ipv4';
    };

    // Checks if this address matches other one within given CIDR range.
    IPv4.prototype.match = function (other, cidrRange) {
        let ref;
        if (cidrRange === undefined) {
            ref = other;
            other = ref[0];
            cidrRange = ref[1];
        }

        if (other.kind() !== 'ipv4') {
            throw new Error('ipaddr: cannot match ipv4 address with non-ipv4 one');
        }

        return matchCIDR(this.octets, other.octets, 8, cidrRange);
    };

    // returns a number of leading ones in IPv4 address, making sure that
    // the rest is a solid sequence of 0's (valid netmask)
    // returns either the CIDR length or null if mask is not valid
    IPv4.prototype.prefixLengthFromSubnetMask = function () {
        let cidr = 0;
        // non-zero encountered stop scanning for zeroes
        let stop = false;
        // number of zeroes in octet
        const zerotable = {
            0: 8,
            128: 7,
            192: 6,
            224: 5,
            240: 4,
            248: 3,
            252: 2,
            254: 1,
            255: 0
        };
        let i, octet, zeros;

        for (i = 3; i >= 0; i -= 1) {
            octet = this.octets[i];
            if (octet in zerotable) {
                zeros = zerotable[octet];
                if (stop && zeros !== 0) {
                    return null;
                }

                if (zeros !== 8) {
                    stop = true;
                }

                cidr += zeros;
            } else {
                return null;
            }
        }

        return 32 - cidr;
    };

    // Checks if the address corresponds to one of the special ranges.
    IPv4.prototype.range = function () {
        return ipaddr.subnetMatch(this, this.SpecialRanges);
    };

    // Returns an array of byte-sized values in network order (MSB first)
    IPv4.prototype.toByteArray = function () {
        return this.octets.slice(0);
    };

    // Converts this IPv4 address to an IPv4-mapped IPv6 address.
    IPv4.prototype.toIPv4MappedAddress = function () {
        return ipaddr.IPv6.parse(`::ffff:${this.toString()}`);
    };

    // Symmetrical method strictly for aligning with the IPv6 methods.
    IPv4.prototype.toNormalizedString = function () {
        return this.toString();
    };

    // Returns the address in convenient, decimal-dotted format.
    IPv4.prototype.toString = function () {
        return this.octets.join('.');
    };

    return IPv4;
})();

// A utility function to return broadcast address given the IPv4 interface and prefix length in CIDR notation
ipaddr.IPv4.broadcastAddressFromCIDR = function (string) {

    try {
        const cidr = this.parseCIDR(string);
        // @ts-ignore
        const ipInterfaceOctets = cidr[0].toByteArray();
        const subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
        const octets = [];
        let i = 0;
        while (i < 4) {
            // Broadcast address is bitwise OR between ip interface and inverted mask
            octets.push(parseInt(ipInterfaceOctets[i], 10) | parseInt(subnetMaskOctets[i], 10) ^ 255);
            i++;
        }

        return new this(octets);
    } catch (e) {
        throw new Error('ipaddr: the address does not have IPv4 CIDR format');
    }
};

// Checks if a given string is formatted like IPv4 address.
ipaddr.IPv4.isIPv4 = function (string) {
    return this.parser(string) !== null;
};

// Checks if a given string is a valid IPv4 address.
ipaddr.IPv4.isValid = function (string) {
    try {
        new this(this.parser(string));
        return true;
    } catch (e) {
        return false;
    }
};

// Checks if a given string is a full four-part IPv4 Address.
ipaddr.IPv4.isValidFourPartDecimal = function (string) {
    if (ipaddr.IPv4.isValid(string) && string.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/)) {
        return true;
    } else {
        return false;
    }
};

// A utility function to return network address given the IPv4 interface and prefix length in CIDR notation
ipaddr.IPv4.networkAddressFromCIDR = function (string) {
    let cidr, i, ipInterfaceOctets, octets, subnetMaskOctets;

    try {
        cidr = this.parseCIDR(string);
        // @ts-ignore
        ipInterfaceOctets = cidr[0].toByteArray();
        subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
        octets = [];
        i = 0;
        while (i < 4) {
            // Network address is bitwise AND between ip interface and mask
            octets.push(parseInt(ipInterfaceOctets[i], 10) & parseInt(subnetMaskOctets[i], 10));
            i++;
        }

        return new this(octets);
    } catch (e) {
        throw new Error('ipaddr: the address does not have IPv4 CIDR format');
    }
};

// Tries to parse and validate a string with IPv4 address.
// Throws an error if it fails.
ipaddr.IPv4.parse = function (string) {
    const parts = this.parser(string);

    if (parts === null) {
        throw new Error('ipaddr: string is not formatted like an IPv4 Address');
    }

    return new this(parts);
};

// Parses the string as an IPv4 Address with CIDR Notation.
ipaddr.IPv4.parseCIDR = function (string) {
    let match;

    if ((match = string.match(/^(.+)\/(\d+)$/))) {
        const maskLength = parseInt(match[2]);
        if (maskLength >= 0 && maskLength <= 32) {
            const parsed = [this.parse(match[1]), maskLength];
            Object.defineProperty(parsed, 'toString', {
                value: function () {
                    return this.join('/');
                }
            });
            return parsed;
        }
    }

    throw new Error('ipaddr: string is not formatted like an IPv4 CIDR range');
};

// Classful variants (like a.b, where a is an octet, and b is a 24-bit
// value representing last three octets; this corresponds to a class C
// address) are omitted due to classless nature of modern Internet.
ipaddr.IPv4.parser = function (string) {
    let match, part, value;

    // parseInt recognizes all that octal & hexadecimal weirdness for us
    if ((match = string.match(ipv4Regexes.fourOctet))) {
        return (function () {
            const ref = match.slice(1, 6);
            const results = [];

            for (let i = 0; i < ref.length; i++) {
                part = ref[i];
                results.push(parseIntAuto(part));
            }

            return results;
        })();
    } else if ((match = string.match(ipv4Regexes.longValue))) {
        value = parseIntAuto(match[1]);
        if (value > 0xffffffff || value < 0) {
            throw new Error('ipaddr: address outside defined range');
        }

        return ((function () {
            const results = [];
            let shift;

            for (shift = 0; shift <= 24; shift += 8) {
                results.push((value >> shift) & 0xff);
            }

            return results;
        })()).reverse();
    } else if ((match = string.match(ipv4Regexes.twoOctet))) {
        return (function () {
            const ref = match.slice(1, 4);
            const results = [];

            value = parseIntAuto(ref[1]);
            if (value > 0xffffff || value < 0) {
                throw new Error('ipaddr: address outside defined range');
            }

            results.push(parseIntAuto(ref[0]));
            results.push((value >> 16) & 0xff);
            results.push((value >>  8) & 0xff);
            results.push( value        & 0xff);

            return results;
        })();
    } else if ((match = string.match(ipv4Regexes.threeOctet))) {
        return (function () {
            const ref = match.slice(1, 5);
            const results = [];

            value = parseIntAuto(ref[2]);
            if (value > 0xffff || value < 0) {
                throw new Error('ipaddr: address outside defined range');
            }

            results.push(parseIntAuto(ref[0]));
            results.push(parseIntAuto(ref[1]));
            results.push((value >> 8) & 0xff);
            results.push( value       & 0xff);

            return results;
        })();
    } else {
        return null;
    }
};

// A utility function to return subnet mask in IPv4 format given the prefix length
ipaddr.IPv4.subnetMaskFromPrefixLength = function (prefix) {
    prefix = parseInt(prefix);
    if (prefix < 0 || prefix > 32) {
        throw new Error('ipaddr: invalid IPv4 prefix length');
    }

    const octets = [0, 0, 0, 0];
    let j = 0;
    const filledOctetCount = Math.floor(prefix / 8);

    while (j < filledOctetCount) {
        octets[j] = 255;
        j++;
    }

    if (filledOctetCount < 4) {
        octets[filledOctetCount] = Math.pow(2, prefix % 8) - 1 << 8 - (prefix % 8);
    }

    return new this(octets);
};

// An IPv6 address (RFC2460)
ipaddr.IPv6 = (function () {
    // Constructs an IPv6 address from an array of eight 16 - bit parts
    // or sixteen 8 - bit parts in network order(MSB first).
    // Throws an error if the input is invalid.
    function IPv6 (parts, zoneId) {
        let i, part;

        if (parts.length === 16) {
            this.parts = [];
            for (i = 0; i <= 14; i += 2) {
                this.parts.push((parts[i] << 8) | parts[i + 1]);
            }
        } else if (parts.length === 8) {
            this.parts = parts;
        } else {
            throw new Error('ipaddr: ipv6 part count should be 8 or 16');
        }

        for (i = 0; i < this.parts.length; i++) {
            part = this.parts[i];
            if (!((0 <= part && part <= 0xffff))) {
                throw new Error('ipaddr: ipv6 part should fit in 16 bits');
            }
        }

        if (zoneId) {
            this.zoneId = zoneId;
        }
    }

    // Special IPv6 ranges
    IPv6.prototype.SpecialRanges = {
        // RFC4291, here and after
        unspecified: [new IPv6([0, 0, 0, 0, 0, 0, 0, 0]), 128],
        linkLocal: [new IPv6([0xfe80, 0, 0, 0, 0, 0, 0, 0]), 10],
        multicast: [new IPv6([0xff00, 0, 0, 0, 0, 0, 0, 0]), 8],
        loopback: [new IPv6([0, 0, 0, 0, 0, 0, 0, 1]), 128],
        uniqueLocal: [new IPv6([0xfc00, 0, 0, 0, 0, 0, 0, 0]), 7],
        ipv4Mapped: [new IPv6([0, 0, 0, 0, 0, 0xffff, 0, 0]), 96],
        // RFC6145
        rfc6145: [new IPv6([0, 0, 0, 0, 0xffff, 0, 0, 0]), 96],
        // RFC6052
        rfc6052: [new IPv6([0x64, 0xff9b, 0, 0, 0, 0, 0, 0]), 96],
        // RFC3056
        '6to4': [new IPv6([0x2002, 0, 0, 0, 0, 0, 0, 0]), 16],
        // RFC6052, RFC6146
        teredo: [new IPv6([0x2001, 0, 0, 0, 0, 0, 0, 0]), 32],
        // RFC4291
        reserved: [[new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]), 32]],
        benchmarking: [new IPv6([0x2001, 0x2, 0, 0, 0, 0, 0, 0]), 48],
        amt: [new IPv6([0x2001, 0x3, 0, 0, 0, 0, 0, 0]), 32],
        as112v6: [new IPv6([0x2001, 0x4, 0x112, 0, 0, 0, 0, 0]), 48],
        deprecated: [new IPv6([0x2001, 0x10, 0, 0, 0, 0, 0, 0]), 28],
        orchid2: [new IPv6([0x2001, 0x20, 0, 0, 0, 0, 0, 0]), 28]
    };

    // Checks if this address is an IPv4-mapped IPv6 address.
    IPv6.prototype.isIPv4MappedAddress = function () {
        return this.range() === 'ipv4Mapped';
    };

    // The 'kind' method exists on both IPv4 and IPv6 classes.
    IPv6.prototype.kind = function () {
        return 'ipv6';
    };

    // Checks if this address matches other one within given CIDR range.
    IPv6.prototype.match = function (other, cidrRange) {
        let ref;

        if (cidrRange === undefined) {
            ref = other;
            other = ref[0];
            cidrRange = ref[1];
        }

        if (other.kind() !== 'ipv6') {
            throw new Error('ipaddr: cannot match ipv6 address with non-ipv6 one');
        }

        return matchCIDR(this.parts, other.parts, 16, cidrRange);
    };

    // returns a number of leading ones in IPv6 address, making sure that
    // the rest is a solid sequence of 0's (valid netmask)
    // returns either the CIDR length or null if mask is not valid
    IPv6.prototype.prefixLengthFromSubnetMask = function () {
        let cidr = 0;
        // non-zero encountered stop scanning for zeroes
        let stop = false;
        // number of zeroes in octet
        const zerotable = {
            0: 16,
            32768: 15,
            49152: 14,
            57344: 13,
            61440: 12,
            63488: 11,
            64512: 10,
            65024: 9,
            65280: 8,
            65408: 7,
            65472: 6,
            65504: 5,
            65520: 4,
            65528: 3,
            65532: 2,
            65534: 1,
            65535: 0
        };
        let part, zeros;

        for (let i = 7; i >= 0; i -= 1) {
            part = this.parts[i];
            if (part in zerotable) {
                zeros = zerotable[part];
                if (stop && zeros !== 0) {
                    return null;
                }

                if (zeros !== 16) {
                    stop = true;
                }

                cidr += zeros;
            } else {
                return null;
            }
        }

        return 128 - cidr;
    };


    // Checks if the address corresponds to one of the special ranges.
    IPv6.prototype.range = function () {
        return ipaddr.subnetMatch(this, this.SpecialRanges);
    };

    // Returns an array of byte-sized values in network order (MSB first)
    IPv6.prototype.toByteArray = function () {
        let part;
        const bytes = [];
        const ref = this.parts;
        for (let i = 0; i < ref.length; i++) {
            part = ref[i];
            bytes.push(part >> 8);
            bytes.push(part & 0xff);
        }

        return bytes;
    };

    // Returns the address in expanded format with all zeroes included, like
    // 2001:0db8:0008:0066:0000:0000:0000:0001
    IPv6.prototype.toFixedLengthString = function () {
        const addr = ((function () {
            const results = [];
            for (let i = 0; i < this.parts.length; i++) {
                results.push(padPart(this.parts[i].toString(16), 4));
            }

            return results;
        }).call(this)).join(':');

        let suffix = '';

        if (this.zoneId) {
            suffix = `%${this.zoneId}`;
        }

        return addr + suffix;
    };

    // Converts this address to IPv4 address if it is an IPv4-mapped IPv6 address.
    // Throws an error otherwise.
    IPv6.prototype.toIPv4Address = function () {
        if (!this.isIPv4MappedAddress()) {
            throw new Error('ipaddr: trying to convert a generic ipv6 address to ipv4');
        }

        const ref = this.parts.slice(-2);
        const high = ref[0];
        const low = ref[1];

        return new ipaddr.IPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    };

    // Returns the address in expanded format with all zeroes included, like
    // 2001:db8:8:66:0:0:0:1
    //
    // Deprecated: use toFixedLengthString() instead.
    IPv6.prototype.toNormalizedString = function () {
        const addr = ((function () {
            const results = [];

            for (let i = 0; i < this.parts.length; i++) {
                results.push(this.parts[i].toString(16));
            }

            return results;
        }).call(this)).join(':');

        let suffix = '';

        if (this.zoneId) {
            suffix = `%${this.zoneId}`;
        }

        return addr + suffix;
    };

    // Returns the address in compact, human-readable format like
    // 2001:db8:8:66::1
    // in line with RFC 5952 (see https://tools.ietf.org/html/rfc5952#section-4)
    IPv6.prototype.toRFC5952String = function () {
        const regex = /((^|:)(0(:|$)){2,})/g;
        const string = this.toNormalizedString();
        let bestMatchIndex = 0;
        let bestMatchLength = -1;
        let match;

        while ((match = regex.exec(string))) {
            if (match[0].length > bestMatchLength) {
                bestMatchIndex = match.index;
                bestMatchLength = match[0].length;
            }
        }

        if (bestMatchLength < 0) {
            return string;
        }

        return `${string.substring(0, bestMatchIndex)}::${string.substring(bestMatchIndex + bestMatchLength)}`;
    };

    // Returns the address in compact, human-readable format like
    // 2001:db8:8:66::1
    // Calls toRFC5952String under the hood.
    IPv6.prototype.toString = function () {
        return this.toRFC5952String();
    };

    return IPv6;

})();

// A utility function to return broadcast address given the IPv6 interface and prefix length in CIDR notation
ipaddr.IPv6.broadcastAddressFromCIDR = function (string) {
    try {
        const cidr = this.parseCIDR(string);
        // @ts-ignore
        const ipInterfaceOctets = cidr[0].toByteArray();
        const subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
        const octets = [];
        let i = 0;
        while (i < 16) {
            // Broadcast address is bitwise OR between ip interface and inverted mask
            // @ts-ignore
            octets.push(parseInt(ipInterfaceOctets[i], 10) | parseInt(subnetMaskOctets[i], 10) ^ 255);
            i++;
        }

        return new this(octets);
    } catch (e) {
        throw new Error(`ipaddr: the address does not have IPv6 CIDR format (${e})`);
    }
};

// Checks if a given string is formatted like IPv6 address.
ipaddr.IPv6.isIPv6 = function (string) {
    return this.parser(string) !== null;
};

// Checks to see if string is a valid IPv6 Address
ipaddr.IPv6.isValid = function (string) {

    // Since IPv6.isValid is always called first, this shortcut
    // provides a substantial performance gain.
    if (typeof string === 'string' && string.indexOf(':') === -1) {
        return false;
    }

    try {
        const addr = this.parser(string);
        new this(addr.parts, addr.zoneId);
        return true;
    } catch (e) {
        return false;
    }
};

// A utility function to return network address given the IPv6 interface and prefix length in CIDR notation
ipaddr.IPv6.networkAddressFromCIDR = function (string) {
    let cidr, i, ipInterfaceOctets, octets, subnetMaskOctets;

    try {
        cidr = this.parseCIDR(string);
        // @ts-ignore
        ipInterfaceOctets = cidr[0].toByteArray();
        subnetMaskOctets = this.subnetMaskFromPrefixLength(cidr[1]).toByteArray();
        octets = [];
        i = 0;
        while (i < 16) {
            // Network address is bitwise AND between ip interface and mask
            // @ts-ignore
            octets.push(parseInt(ipInterfaceOctets[i], 10) & parseInt(subnetMaskOctets[i], 10));
            i++;
        }

        return new this(octets);
    } catch (e) {
        throw new Error(`ipaddr: the address does not have IPv6 CIDR format (${e})`);
    }
};

// Tries to parse and validate a string with IPv6 address.
// Throws an error if it fails.
ipaddr.IPv6.parse = function (string) {
    const addr = this.parser(string);

    if (addr.parts === null) {
        throw new Error('ipaddr: string is not formatted like an IPv6 Address');
    }

    return new this(addr.parts, addr.zoneId);
};

ipaddr.IPv6.parseCIDR = function (string) {
    let maskLength, match, parsed;

    if ((match = string.match(/^(.+)\/(\d+)$/))) {
        maskLength = parseInt(match[2]);
        if (maskLength >= 0 && maskLength <= 128) {
            parsed = [this.parse(match[1]), maskLength];
            Object.defineProperty(parsed, 'toString', {
                value: function () {
                    return this.join('/');
                }
            });
            return parsed;
        }
    }

    throw new Error('ipaddr: string is not formatted like an IPv6 CIDR range');
};

// Parse an IPv6 address.
ipaddr.IPv6.parser = function (string) {
    let addr, i, match, octet, octets, zoneId;

    if ((match = string.match(ipv6Regexes.deprecatedTransitional))) {
        return this.parser(`::ffff:${match[1]}`);
    }
    if (ipv6Regexes.native.test(string)) {
        return expandIPv6(string, 8);
    }
    if ((match = string.match(ipv6Regexes.transitional))) {
        zoneId = match[6] || '';
        addr = expandIPv6(match[1].slice(0, -1) + zoneId, 6);
        if (addr.parts) {
            octets = [
                parseInt(match[2]),
                parseInt(match[3]),
                parseInt(match[4]),
                parseInt(match[5])
            ];
            for (i = 0; i < octets.length; i++) {
                octet = octets[i];
                if (!((0 <= octet && octet <= 255))) {
                    return null;
                }
            }

            addr.parts.push(octets[0] << 8 | octets[1]);
            addr.parts.push(octets[2] << 8 | octets[3]);
            return {
                parts: addr.parts,
                zoneId: addr.zoneId
            };
        }
    }

    return null;
};

// A utility function to return subnet mask in IPv6 format given the prefix length
ipaddr.IPv6.subnetMaskFromPrefixLength = function (prefix) {
    prefix = parseInt(prefix);
    if (prefix < 0 || prefix > 128) {
        throw new Error('ipaddr: invalid IPv6 prefix length');
    }

    const octets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let j = 0;
    const filledOctetCount = Math.floor(prefix / 8);

    while (j < filledOctetCount) {
        octets[j] = 255;
        j++;
    }

    if (filledOctetCount < 16) {
        octets[filledOctetCount] = Math.pow(2, prefix % 8) - 1 << 8 - (prefix % 8);
    }

    return new this(octets);
};

// Try to parse an array in network order (MSB first) for IPv4 and IPv6
ipaddr.fromByteArray = function (bytes) {
    const length = bytes.length;

    if (length === 4) {
        return new ipaddr.IPv4(bytes);
    } else if (length === 16) {
        return new ipaddr.IPv6(bytes);
    } else {
        throw new Error('ipaddr: the binary input is neither an IPv6 nor IPv4 address');
    }
};

// Checks if the address is valid IP address
ipaddr.isValid = function (string) {
    return ipaddr.IPv6.isValid(string) || ipaddr.IPv4.isValid(string);
};


// Attempts to parse an IP Address, first through IPv6 then IPv4.
// Throws an error if it could not be parsed.
ipaddr.parse = function (string) {
    if (ipaddr.IPv6.isValid(string)) {
        return ipaddr.IPv6.parse(string);
    } else if (ipaddr.IPv4.isValid(string)) {
        return ipaddr.IPv4.parse(string);
    } else {
        throw new Error('ipaddr: the address has neither IPv6 nor IPv4 format');
    }
};

// Attempt to parse CIDR notation, first through IPv6 then IPv4.
// Throws an error if it could not be parsed.
ipaddr.parseCIDR = function (string) {
    try {
        return ipaddr.IPv6.parseCIDR(string);
    } catch (e) {
        try {
            return ipaddr.IPv4.parseCIDR(string);
        } catch (e2) {
            throw new Error('ipaddr: the address has neither IPv6 nor IPv4 CIDR format');
        }
    }
};

// Parse an address and return plain IPv4 address if it is an IPv4-mapped address
ipaddr.process = function (string) {
    const addr = this.parse(string);
    // @ts-ignore
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
        // @ts-ignore
        return addr.toIPv4Address();
    } else {
        return addr;
    }
};

// An utility function to ease named range matching. See examples below.
// rangeList can contain both IPv4 and IPv6 subnet entries and will not throw errors
// on matching IPv4 addresses to IPv6 ranges or vice versa.
ipaddr.subnetMatch = function (address, rangeList, defaultName) {
    let i, rangeName, rangeSubnets, subnet;

    if (defaultName === undefined || defaultName === null) {
        defaultName = 'unicast';
    }

    for (rangeName in rangeList) {
        if (Object.prototype.hasOwnProperty.call(rangeList, rangeName)) {
            rangeSubnets = rangeList[rangeName];
            // ECMA5 Array.isArray isn't available everywhere
            if (rangeSubnets[0] && !(rangeSubnets[0] instanceof Array)) {
                rangeSubnets = [rangeSubnets];
            }

            for (i = 0; i < rangeSubnets.length; i++) {
                subnet = rangeSubnets[i];
                if (address.kind() === subnet[0].kind() && address.match.apply(address, subnet)) {
                    return rangeName;
                }
            }
        }
    }

    return defaultName;
};

export function isIP(addr) {
    return ipaddr.isValid(addr);
}

export function version(addr) {
    try {
        const parse_addr = ipaddr.parse(addr);
        const kind = parse_addr.kind();

        if (kind === 'ipv4') {
            return 4; //IPv4
        } else if (kind === 'ipv6') {
            return 6; //IPv6
        } else {
            /* istanbul ignore next */
            return 0; //not 4 or 6
        }
    } catch (err) {
        return 0; //not 4 or 6
    }
}

export function isV4(addr) {
    return version(addr) === 4;
}

export function isV6(addr) {
    return version(addr) === 6;
}

export function isRange(range) {
    try {
        const cidr = ipaddr.parseCIDR(range);
        return true;
    } catch (err) {
        return false;
    }
}

export function inRange(addr, range) {
    if (typeof range === 'string') {
        if (range.indexOf('/') !== -1) {
            try {
                const range_data = range.split('/');

                const parse_addr = ipaddr.parse(addr);
                const parse_range = ipaddr.parse(range_data[0]);

                //@ts-ignore:  It works.
                return parse_addr.match(parse_range, range_data[1]);
            } catch (err) {
                return false;
            }
        } else {
            addr = isV6(addr) ? ip6.normalize(addr) : addr; //v6 normalize addr
            range = isV6(range) ? ip6.normalize(range) : range; //v6 normalize range

            return isIP(range) && addr === range;
        }
    } else if (range && typeof range === 'object') {
        //list
        for (const check_range in range) {
            if (inRange(addr, range[check_range]) === true) {
                return true;
            }
        }
        return false;
    } else {
        return false;
    }
}

export function storeIP(addr) {
    try {
        var parse_addr = ipaddr.parse(addr);
        var kind = parse_addr.kind();

        if (kind === 'ipv4') {
            //is a plain v4 address
            return addr;
        } else if (kind === 'ipv6') {
            //@ts-ignore:  it exists!
            if (parse_addr.isIPv4MappedAddress()) {
                //convert v4 mapped to v6 addresses to a v4 in it's original format
                //@ts-ignore:  it exists!
                return parse_addr.toIPv4Address().toString();
            } //is a v6, abbreviate it
            else {
                return ip6.abbreviate(addr);
            }
        } else {
            return null; //invalid IP address
        }
    } catch (err) {
        return null; //invalid IP address
    }
}

// searchIP is a aliases of storeIP
export { storeIP as searchIP };

export function displayIP(addr) {
    try {
        var parse_addr = ipaddr.parse(addr);
        var kind = parse_addr.kind();

        if (kind === 'ipv4') {
            //is a plain v4 address
            return addr;
        } else if (kind === 'ipv6') {
            //@ts-ignore:  it exists!
            if (parse_addr.isIPv4MappedAddress()) {
                //convert v4 mapped to v6 addresses to a v4 in it's original format
                //@ts-ignore:  it exists!
                return parse_addr.toIPv4Address().toString();
            } //is a v6, normalize it
            else {
                return ip6.normalize(addr);
            }
        } else {
            return ''; //invalid IP address
        }
    } catch (err) {
        return ''; //invalid IP address
    }
}