'use strict';

var sugar = require('sugar');
var irc = require('irc');
var webSocket = require('ws');

var channel = '#atp';
var webAddress = 'http://www.caseyliss.com/showbot';
var TITLE_LIMIT = 75;

var titles = [];
var connections = [];
var links = [];

var client;

client = new irc.Client('irc.freenode.net', 'accidentalbot', {
    channels: [channel],
    autoconnect: false
});


// Automatically connect to IRC if this file is run directly, not require()d.
function main() {
    client.connect();

    if (process.send) {
        process.on('message', function(data) {
            if (data.method == 'load') {
                console.log("Restarting saved state");
                titles = data.params.state.titles;
                links = data.params.state.links;
            }
        });

        process.send({
            method: 'request-load'
        });
    }
}

if (require.main === module) {
    main();
}

function sendToAll(packet) {
    connections.forEach(function (connection) {
        connection.send(JSON.stringify(packet));
    });
}

function saveBackup() {
    if (process.send) {
        console.log("Saving state");
        process.send({
            method: 'save',
            params: {
                state: {
                    titles: titles,
                    links: links
                }
            }
        });
    } else {
        console.log("Save not implemented.");
    }
}

function handleNewSuggestion(from, message) {
    var title = '';
    if (message.match(/^!s(?:uggest)?\s+(.+)/)) {
        title = RegExp.$1.compact();
    }

    if (title.length > TITLE_LIMIT) {
        client.say(from, 'That title is too long (over ' + TITLE_LIMIT +
            ' characters); please try again.');
        title = '';
    }
    if (title.length > 0) {
        // Make sure this isn't a duplicate.
        if (titles.findAll({titleLower: title.toLowerCase()}).length === 0) {
            title = {
                id: titles.length,
                author: from,
                title: title,
                titleLower: title.toLowerCase(),
                votes: 0,
                votesBy: [],
                time: new Date()
            };
            titles.push(title);

            sendToAll({operation: 'NEW', title: title});
        } else {
            //client.say(channel, 'Sorry, ' + from + ', your title is a duplicate. Please try another!');
            client.say(from, 'Sorry, your title is a duplicate. Please try another!');
        }
    }
}

function handleSendVotes(from, message) {
    var titlesByVote = titles.sortBy(function (t) {
        return t.votes;
    }, true).to(3);

    client.say(from, 'Three most popular titles:');
    for (var i = 0; i < titlesByVote.length; ++i) {
        var votes = titlesByVote[i]['votes'];
        client.say(from, titlesByVote[i]['votes'] + ' vote' + (votes != 1 ? 's' : '') +  ': " ' + titlesByVote[i].title + '"');
    }
}

function handleNewLink(from, message) {
    if (message.startsWith('!link')) {
        message = message.substring(6);
    } else if (message.startsWith('!l')) {
        message = message.substring(3);
    }

    if (message.startsWith('http')) {
        var link = {
            id: links.length,
            author: from,
            link: message,
            time: new Date()
        };
        links.push(link);

        sendToAll({operation: 'NEWLINK', link: link});
    } else {
        client.say(from, "That doesn't look like a link to me.");
    }
}

function handleHelp(from) {
    client.say(from, 'Options:');
    client.say(from, '!s {title} - suggest a title.');
    client.say(from, '!votes - get the three most highly voted titles.');
    client.say(from, '!link {URL} - suggest a link.');
    client.say(from, '!help - see this message.');
    client.say(from, 'To see titles/links, go to: ' + webAddress);
}

client.addListener('join', function (channel, nick, message) {
    console.log('Joined channel ' + channel);
    setInterval(saveBackup, 30000);
});

client.addListener('message', function (from, to, message) {
    if (message.startsWith('!s')) {
        handleNewSuggestion(from, message);
    } else if (message.startsWith("!votes")) {
        handleSendVotes(from, message);
    } else if (message.startsWith('!l')) {
        handleNewLink(from, message);
    } else if (message.startsWith('!help')) {
        handleHelp(from);
    }
});

client.addListener('error', function (message) {
    console.log('error: ', message);
});

/***************************************************
 * WEB SOCKETS                                     *
 ***************************************************/

var port = Number(process.env.PORT || 5001);
var proxied = process.env.PROXIED === 'true';
var socketServer = new webSocket.Server({port: port});

// DOS protection - we disconnect any address which sends more than windowLimit
// messages in a window of windowSize milliseconds.
var windowLimit = 50;
var windowSize = 5000;
var currentWindow = 0;
var recentMessages = {};
var disconnectedThisWindow = {};
function floodedBy(socket, floodMultiplier) {
    // To be called each time we get a message or connection attempt.
    //
    // If that address has been flooding us, we disconnect all open connections
    // from that address and return `true` to indicate that it should be
    // ignored. (They will not be prevented from re-connecting after waiting
    // for the next window.)
    //
    // Use floodMultiplier if a particular action be a stronger offence.
    var address = getRequestAddress(socket.upgradeReq);

    if (disconnectedThisWindow[address]) {
        socket.terminate();
        return true;
    }

    var updatedWindow = 0 | ((new Date) / windowSize);
    if (currentWindow !== updatedWindow) {
        currentWindow = updatedWindow;
        recentMessages = {};
        disconnectedThisWindow = {};
    }

    if (!(address in recentMessages)) {
        recentMessages[address] = 0
    }
    recentMessages[address] += (floodMultiplier || 1);

    if (recentMessages[address] > windowLimit) {
        console.warn("Disconnecting flooding address: " + address);
        socket.terminate();

        for (var i = 0, l = connections.length; i < l; i++) {
            if (getRequestAddress(connections[i].upgradeReq) === address &&
                connections[i] != socket) {
                connections[i].terminate();
            }
        }

        disconnectedThisWindow[address] = true;
        return true;
    } else {
        return false;
    }
}

function getRequestAddress(request) {
    if (proxied && 'x-forwarded-for' in request.headers) {
        // This assumes that the X-Forwarded-For header is generated by a
        // trusted proxy such as Heroku. If not, a malicious user could take
        // advantage of this logic and use it to to spoof their IP.
        var forwardedForAddresses = request.headers['x-forwarded-for'].split(',');
        return forwardedForAddresses[forwardedForAddresses.length - 1].trim();
    } else {
        // This is valid for direct deployments, without routing/load balancing.
        return request.connection.remoteAddress;
    }
}

socketServer.on('connection', function(socket) {
    if (floodedBy(socket)) return;

    connections.push(socket);
    var address = getRequestAddress(socket.upgradeReq);
    console.log('Client connected: ' + address);

    // Instead of sending all of the information about current titles to the
    // newly-connecting user, which would include the IP addresses of other
    // users, we just send down the information they need.
    var titlesWithVotes = titles.map(function (title) {
        var isVoted = title.votesBy.some(function (testAddress) {
            return testAddress === address;
        });
        var newTitle = {
            id: title.id,
            author: title.author,
            title: title.title,
            votes: title.votes,
            voted: isVoted,
            time: title.time
        };
        return newTitle;
    });
    socket.send(JSON.stringify({operation: 'REFRESH', titles: titlesWithVotes, links: links}));

    socket.on('error', function(error) {
        if (floodedBy(socket)) return;
        console.error("Error from socket for " + address + ": " + error);
    });

    socket.on('close', function () {
        console.log('Client disconnected: ' + address);
        connections.splice(connections.indexOf(socket), 1);
    });

    socket.on('message', function (data, flags) {
        if (floodedBy(socket)) return;

        if (flags.binary) {
            console.warn("Disconnecting "  + address + " due to binary message");
            floodedBy(socket, Infinity);
            return;
        }

        try {
            var packet = JSON.parse(data);
        } catch (e) {
            console.warn("Disconnecting "  + address + " due to invalid JSON");
            floodedBy(socket, Infinity);
            return;
        }

        if (packet.operation === 'VOTE') {
            var matches = titles.findAll({id: packet['id']});

            if (matches.length > 0) {
                var upvoted = matches[0];
                if (upvoted['votesBy'].any(address) === false) {
                    upvoted['votes'] = Number(upvoted['votes']) + 1;
                    upvoted['votesBy'].push(address);
                    sendToAll({operation: 'VOTE', votes: upvoted['votes'], id: upvoted['id']});
                    console.log('+1 for ' + upvoted['title'] + ' by ' + address);
                } else {
                    console.log('ignoring duplicate vote by ' + address + ' for ' + upvoted['title']);
                }
            } else {
                // Make votes for non-existent IDs count 5x as strongly as flooding 
                floodedBy(socket, 4);
                console.log('' + address + ' attempted to vote for non-existent id: ' + packet['id']);
            }
        } else if (packet.operation === 'PING') {
            socket.send(JSON.stringify({operation: 'PONG'}));
            console.log("sending PONG reply to " + address)
        } else {
            console.warn("" + address + " requested non-existent operation " + packet['operation']);
        }
    });
});


// currently only used for testing
module.exports = {
    main: main,

    _getStateForTest: function() {
        return {
            client: client,
            port: port,
            socketServer: socketServer
        };
    }
};
