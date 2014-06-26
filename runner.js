// Runs accidentalbot.js, restarting it if it crashes and maintaining state.
var assert = require('assert');
var child_process = require('child_process');


function main() {
    var runner = new BotRunner();
    runner.run();
}


function BotRunner() {
    this.process = null;
    this.state = null;
}


BotRunner.prototype = {
    run: function() {
        assert(this.process === null);

        this.process = child_process.fork('./accidentalbot.js');
        this.process.on('message', this.onProcessMessage.bind(this));
        this.process.on('exit', this.onProcessExit.bind(this));
    },

    onProcessMessage: function(message) {
        if (message.method === 'save') {
            console.log("Saving state received from process.");
            this.state = message.params.state;
        } else if (message.method === 'request-load') {
            if (this.state === null) {
                return;
            }

            console.log("Sending requested state to process.");
            this.process.send({
                method: 'load',
                params: {
                    state: this.state
                }
            })
        }
    },

    onProcessExit: function(code) {
        console.warn("Process exited with status code " + code + ".");
        this.process.removeAllListeners();
        this.process = null;

        process.nextTick(this.run.bind(this));
    }
};


if (require.main === module) {
    main();
}
