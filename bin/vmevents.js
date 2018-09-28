var assert = require('assert-plus');
var restify = require('restify');
var watershed = require('watershed');

var ws = new watershed.Watershed();
var wskey = ws.generateKey();
var opts = {
    agent: false,
    headers: {
        connection: 'upgrade',
        upgrade: 'websocket',
        'Sec-WebSocket-Key': wskey,
        'Sec-WebSocket-Version': '13',
    }
};

var client = restify.createClient({
    url: 'http://127.0.0.1:9090'
});

function getEvents() {
    console.error('<Watching for events for server ' + opts.headers.Server + '>');
    client.get(opts, function _onGet(err, res, socket, head) {
        res.once('upgradeResult', function _onUpgrade(upErr, upRes, upSocket, upHead) {
            var shed = ws.connect(upRes, upSocket, upHead, wskey);
            shed.on('text', function _onText(msg) {
                var obj = JSON.parse(msg);
                console.log(JSON.stringify(obj));
            });
            shed.on('end', function _onEnd() {
                console.error('<connection closed>');
                setImmediate(getEvents);
            });
        });
    });
}

opts.headers.Server = process.argv[process.argv.length - 1];
assert.uuid(opts.headers.Server, 'cli arg must be uuid');

getEvents();
