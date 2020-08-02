const net = require('net');
const fs = require('fs');
const dgram = require('dgram');
const buffer = require('buffer');
const path = require('path');
const prompt = require('prompt-sync')({sigint: true});
const inquirer = require('inquirer');

const udpServer = dgram.createSocket('udp4');
const udpClient = dgram.createSocket('udp4');

let tcpPort = null;
let udpPort = null;
let tcpClient = net.Socket();

console.log(process.argv)
const KNOWN_NODES_FILE = process.argv[2];
const FILES_DIR = process.argv[3];
let CURRENT_NODE_NAME;
if(!!process.argv[4]) {
    CURRENT_NODE_NAME = process.argv[4];
} else {
    CURRENT_NODE_NAME = 'unnamed';
}

const UDP_GET_WAIT_TIMEOUT = 5000;


let knownNodes = getKnownNodesFromFile();
let availableFiles = getAvailableFiles();

let isSearching = false;
let fileFound = false;
let fileToSearch = null;
let foundNode = null;

const askInputCommand = () => {
    inquirer.prompt([{name: 'input', message: '>', type: 'input'}])
    .then(answer => {
        let trimmed = answer.input.trim();
        if(trimmed === 'list') {
            console.log(knownNodes);
            askInputCommand();
        } else if(trimmed.startsWith("get ")) {
            console.log(trimmed)
            isSearching = true;
            fileToSearch = trimmed.replace("get ", "");
            setTimeout(() => {
                isSearching = false;
                if(!fileFound) {
                    console.log(`${fileToSearch} not found.`)
                }
                fileFound = false;
                askInputCommand();
            }, UDP_GET_WAIT_TIMEOUT);
            console.log(`Searching for ${fileToSearch} ...`)
            //send get file.html to all known nodes
            for(let node of knownNodes) {
                udpClient.send(Buffer.from(trimmed), node.port, node.ip, err => {})
            }
        } else {
            askInputCommand();
        }
    })
    .catch(errors => {

    })
}

function getAvailableFiles() {
    return fs.readdirSync(FILES_DIR);
}

function getKnownNodesFromFile() {
    return fs.readFileSync(KNOWN_NODES_FILE, 'utf-8').split("\n").map(node => {
        let splitted = node.split(" ");
        return {
            name: splitted[0],
            ip: splitted[1],
            port: Number(splitted[2])
        }   
    }).filter(node => !!node.name && !!node.ip && !!node.port);
} 

function writeKnownNodesToFile() {
    fs.writeFileSync(KNOWN_NODES_FILE, knownNodes.map(knode => `${knode.name} ${knode.ip} ${knode.port}`).join('\n'));  
}

function searchInFiles(query) {
    console.log('search by query ', query, '=', result);
    return availableFiles.some(file => file == query);
}

udpServer.on('error', err => {
    console.log(`UDP server error. ${err.stack}`)
    udpServer.close();
})

udpServer.on('listening', () => {
    udpPort = udpServer.address().port;
    console.log(`Listening on ${udpServer.address().address}:${udpServer.address().port} via UDP...`)
})

udpServer.on('message', (message, rinfo) => {
    let stringifiedMessage = message.toString().trim();
    if(stringifiedMessage.startsWith("get ")) {
        if(searchInFiles(stringifiedMessage.replace("get ", ""))) {
            udpClient.send(`getres ${tcpPort}`, rinfo.port, rinfo.address, err => {
                console.log(`Error sending tcp port as query res. ${err.stack}`)
            })
        }
    } else if(stringifiedMessage.startsWith("getres ")) {
        //connect using tcp client to tcp port and download file.
        let tcpPort = Number(stringifiedMessage.replace("getres ", ""));
        if(isSearching == true) {
                foundNode = knownNodes.find(node => node.ip === rinfo.address().address && node.port == rinfo.address().port);
                foundNode.tcpPort = Number(message.replace("getres ", ""))
                fileFound = true;
                isSearching = false;
                console.log(`Node found. receiving file now via ${foundNode}`);
    
                let writeStream = fs.createWriteStream(`${FILES_DIR}/${fileToSearch}`, {encoding: 'utf-8'})
    
                tcpClient.connect(foundNode.port, foundNode.ip, () => {
                    tcpClient.write(Buffer.from(fileToSearch.toString()));
                    tcpClient.end();
                })

                tcpClient.on('data', data => {
                    console.log("Downloading file ...")
                    writeStream.write(data);
                })

                tcpClient.on('end', () => {
                    console.log('File downloaded.')
                    writeStream.close()
                    tcpClient.end();
                    askInputCommand();
                })
        }
    } else {
        console.log('Discovery Received.')
        let reallyNewNodes = getReallyNewNodes(createNodeArrayFromString(stringifiedMessage, ','));
        console.log('really new nodes', reallyNewNodes);
        if(reallyNewNodes.length > 0) {
            knownNodes = concat(reallyNewNodes);
            writeKnownNodesToFile();
        }
        askInputCommand();
    }
})



const broadcastKnownNodes = () => {
    console.log('Broadcasting current known nodes...')
    let bufferedData = [];
    //Create buffered of stringified nodes to broadcast
    console.log('before loop')
    for(let node of knownNodes) {
        bufferedData.push(Buffer.from(`${node.name} ${node.ip} ${node.port},`))
    }
    console.log('after loop');
    bufferedData.push(Buffer.from(`${CURRENT_NODE_NAME} ${udpServer.address().ip} ${udpServer.address().port}`))
    console.log('after me');
    //Broadcast created buffer to currently known nodes
    // console.log(bufferedData.toString());
    for(let node of knownNodes) {
        udpClient.send(bufferedData, node.port, node.ip, err => {
            if(err) { 
                console.log(`Error sending known nodes to ${node.ip}:${node.port} via UDP.`)
            }
        })
    }
    askInputCommand();
}

let udpClientBroadcastInterval = setInterval(broadcastKnownNodes, 7000);

function createNodeArrayFromString(stringifiedNodes, seperator) {
    //Trim to remove redundant whitespaces
    stringifiedNodes = stringifiedNodes.trim();
    // console.log(stringifiedNodes);
    //creat and return result by separator
    return stringifiedNodes.split(seperator).map(item => {
        let splitted = item.split(" ");
        return {
            name: splitted[0],
            ip: splitted[1],
            port: Number(splitted[2])
        }
    });
}

function getReallyNewNodes(newNodes) {
    //remove nodes which are duplicated or are us! and then return the results as a really new nodes to add!.
    return newNodes.filter(newNode => {
        let isNodeAlreadyKnown = knownNodes.findIndex(knode => knode.name == newNode.name && knode.ip == newNode.ip) != -1
        let isItMe = newNode.name == CURRENT_NODE_NAME;
        return !isNodeAlreadyKnown && !isItMe;
    })
};

udpServer.bind();

const tcpServer = net.createServer(clientSocket => {
    clientSocket.setEncoding('utf-8');
    clientSocket.on('data', fileToSendToClient => {
        fileToSendToClient = fileToSendToClient.toString().trim();
        clientSocket.write(fs.readFileSync(`${FILES_DIR}/${fileToSendToClient}`))
        clientSocket.end();
    })
}) 

tcpServer.listen(() => {
    tcpPort = tcpServer.address().port;
    console.log(`Listening on ${tcpServer.address().address}:${tcpServer.address().port} via TCP...`);
});

tcpServer.on('connection', socket => {
    socket.on('data', requestedFile => {
        let writeStream = fs.createWriteStream(`${FILES_DIR}/${requestedFile}`, {
            encoding: 'utf-8'
        })

        writeStream.write()
    })
})


askInputCommand();