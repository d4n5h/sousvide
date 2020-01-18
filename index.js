const express = require('express'),
    ejs = require('ejs'),
    nodemailer = require('nodemailer'),
    bodyParser = require('body-parser'),
    chalk = require('chalk'),
    publicIp = require('public-ip'),
    internalIp = require('internal-ip'),
    timeseries = require("timeseries-analysis"),
    watch = require('node-watch'),
    path = require('path'),
    fs = require('fs'),
    Promised = require('./lib/promised'),
    { Thermometer } = require("johnny-five"),
    PID = require('pid-controller'),
    five = require("johnny-five"),
    board = new five.Board();
_this = this;

function inRange(x, min, max) {
    if (x >= min && x <= max) {
        return true;
    } else {
        return false;
    }
}
Array.prototype.max = function () {
    return Math.max.apply(null, this);
};

Array.prototype.min = function () {
    return Math.min.apply(null, this);
};
function predict(data, steps) {
    if (steps > 0) {
        let dists = [];
        let total = 0;
        for (let i = 0; i < data.length; i++) {
            if (i != data.length - 1) {
                if (data[i] < data[i + 1]) {
                    dists.push(Math.abs(data[i] - (data[i + 1])) / 2);
                } else if (data[i] > data[i + 1]) {
                    dists.push(- Math.abs(data[i] - (data[i + 1])) / 2);
                } else {
                    dists.push(Math.abs(data[i] - (data[i + 1])) / 2);
                }
            }
        }

        for (let i = 0; i < dists.length; i++) {
            total += dists[i];
        }

        data[data.length] = data[data.length - 1] + (total / data.length);
        steps--;
        return predict(data, steps);

    } else {
        return data;
    }
}

// Load general configuration
fs.readFile('./conf.json', async (err, config) => {
    config = await Promised(config, (data) => {
        return JSON.parse(data)
    });
    // General variables
    let timer = 0,
        isPaused = true,
        clnt = null,
        idleTemp = 0,
        currentTemp = 0,
        notifyCount = 0,
        log = [],
        predictionLog = [],
        rly = null;

    board.on("ready", () => {
        // Thermometer configuration
        const thermometer = new Thermometer({
            controller: "DS18B20",
            pin: 4
        });

        // Relay configuration
        const relay = new five.Relay({
            pin: 10,
            type: 'NC'
        });

        rly = relay;
        //console.log(this)

        // Listen for temperature change
        thermometer.on("change", () => {
            const { address, celsius, fahrenheit, kelvin } = thermometer;
            if (config.tempMode == 'C') {
                currentTemp = celsius;
            } else {
                currentTemp = fahrenheit;
            }
        });

        // Inject relay
        // this.repl.inject({
        //     relay: relay
        // });
    });

    watch('./presets.json', { recursive: false }, (evt, name) => {
        fs.readFile('./presets.json', async (err, presets) => {
            presets = await Promised(presets, (data) => {
                return JSON.parse(data)
            });
            if (clnt != null) {
                clnt.emit('presetChange', presets)
                clnt.broadcast.emit('presetChange', presets)
            }
        });
    });


    // Socket.io configuration
    const server = require('http').createServer();
    const io = require('socket.io')(server);

    // Email configuration
    if (config.toNotify) {
        const transporter = nodemailer.createTransport({
            service: config.email_service,
            auth: {
                user: config.email_account,
                pass: config.email_password
            }
        });

        const mailOptions = {
            from: config.email_account,
            to: config.email_account,
            subject: 'Sous Vide Notification',
            text: 'Food is ready!'
        };
    }

    // Timer loop
    function checkTime() {
        if (clnt != null) {
            if (isPaused == false) {
                timer = timer - 1;
            }
            if (0 >= timer) {
                clnt.emit('timer_tick', 0);
                clnt.broadcast.emit('timer_tick', 0);
                if (notifyCount == 0 && isPaused == false && config.toNotify == true) {
                    transporter.sendMail(mailOptions, function (error, info) {
                        if (error) {
                            console.log(error);
                        } else {
                            console.log('Email sent: ' + info.response);
                        }
                    });
                    console.log('Notified')
                    notifyCount++;
                }
            } else {
                clnt.emit('timer_tick', timer);
                clnt.broadcast.emit('timer_tick', timer);
            }
        }
        setTimeout(() => {
            checkTime();
        }, 1000);
    }

    let countLogEmit = 0;

    // Temperature loop
    function checkTemp() {
        if (countLogEmit >= 9 && clnt != null) {
            log.push([Date.now(), currentTemp]);
            predictionLog.push(currentTemp);
            clnt.emit('logUpdate', [Date.now(), currentTemp]);
            clnt.broadcast.emit('logUpdate', [Date.now(), currentTemp]);
            countLogEmit = 0;
        }
        if (clnt != null) {
            clnt.emit('tempData', {
                idle: idleTemp,
                current: currentTemp
            });
            clnt.broadcast.emit('tempData', {
                idle: idleTemp,
                current: currentTemp
            });
        }

        if (predictionLog.length > 30) {
            if (clnt != null) {
                clnt.emit('regulatedBy', 1);
                clnt.broadcast.emit('regulatedBy', 1);
            }
            let predictions = predict(predictionLog.slice(Math.max(predictionLog.length - 30, 1)), 30);
            predictions = predictions.slice(Math.max(predictions.length - 30, 1));
            const min = Math.min(predictions);
            const max = predictions.max();
            if (max > Number(idleTemp - 0.5) && timer > 0) {
                if (clnt != null) {
                    clnt.emit('relay_status', false);
                    clnt.broadcast.emit('relay_status', false);
                }
                if (rly != null) {
                    rly.off()
                }
            } else if (max < Number(idleTemp + 0.5) && timer > 0) {
                if (clnt != null) {
                    clnt.emit('relay_status', true);
                    clnt.broadcast.emit('relay_status', true);
                }

                if (rly != null) {
                    rly.on()
                }
            }
        } else {
            if (currentTemp < idleTemp && timer > 0) {
                if (clnt != null) {
                    clnt.emit('relay_status', true);
                    clnt.broadcast.emit('relay_status', true);
                }

                if (rly != null) {
                    rly.on()
                }

            } else {
                if (clnt != null) {
                    clnt.emit('relay_status', false);
                    clnt.broadcast.emit('relay_status', false);
                }
                if (rly != null) {
                    rly.off()
                }
            }
        }
        countLogEmit++;
        setTimeout(() => {
            checkTemp();
        }, 1000);
    }

    checkTime();
    checkTemp();

    io.on('connection', (client) => {
        clnt = client;
        client.on('timer_start', (data) => {
            timer = data;
            notifyCount = 0;
        });

        client.on('isPaused', (data) => {
            isPaused = data;
        });

        client.on('do_reset', () => {
            timer = 0;
            isPaused = true;
            notifyCount = 0;
        });

        client.on('setTemperature', (data) => {
            idleTemp = data;
        });
    });

    server.listen(7777);

    const app = express();

    // View settings
    app.set("view engine", "ejs");
    app.set("views", __dirname + "/views");

    // CORS middleware
    app.use(function (req, res, next) {
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    });

    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());
    app.use('/', express.static(path.join(__dirname, '/')))

    // Root Path
    app.get('/', async (req, res) => {
        res.set("Set-Cookie", "cross-site-cookie=name; SameSite=None; Secure");
        let conf = {};
        conf.tempMode = config.tempMode;
        if (conf.tempMode == 'C') {
            conf.tempSymbol = 'c';
            conf.tempName = 'Celsius';
        } else if (conf.tempMode == 'F') {
            conf.tempSymbol = 'f';
            conf.tempName = 'Fahrenheit';
        }
        conf.host = req.get('host').split(':')[0];
        res.render("index", conf);
    })

    // API - Get presets
    app.get('/api/getPresets', async (req, res) => {
        fs.readFile('./presets.json', async (err, presets) => {
            res.contentType('text/json');
            res.send(presets);
        })
    })

    // API - Get log
    app.get('/api/getLog', async (req, res) => {
        res.contentType('text/json');
        res.send(JSON.stringify(log));
    })

    app.listen(config.port);

    (async () => {
        //         console.log(chalk.bold.blue(`
        //             '-/osyhhdddhhyso/-'             
        //         ':oydddddddddddddddddddyo:'         
        //        .ohdddddddddddddddddddddddddho.       
        //      -sddddddddddddddddddddddddddddddds-     
        //    'ohddddddddddddhyo++oshhddddddddddddho'   
        //   .ydddddddddhhhhy:'  '---/yhhhhdddddddddy.  
        //  .hdddddddhs/-..-'    '----:/::/+yhdddddddh. 
        // 'ydddddddd+           '-----------oddddddddy'
        // /ddddddddd'           '------------mmddddddd/
        // yddddddddd/           '-----------oNNmmdddddy
        // hdddddddddho:...      '------:::+ymNNNNmmdddh
        // hddddddddddddhdd-     '-----/ddmNNNNNNNNNmmdh
        // yddddddddddddddd-     '-----/NNNNNNNNNNNNNNmh
        // /ddddddddddddddd-     '-----/NNNNNNNNNNNNNNN+
        // 'ydddddddddddddd-     '-----/NNNNNNNNNNNNNNh'
        //  .hddddddddddddd-     .-----/NNNNNNNNNNNNNd. 
        //   .ydddddddddddd:.....://///+NNNNNNNNNNNNd.  
        //    'ohddddddddddhddddddmmmmmmNNNNNNNNNNms'   
        //      -sddddddddddddmNNNNNNNNNNNNNNNNNNy-     
        //        .ohdddddddddddmNNNNNNNNNNNNNms-       
        //          ':oyddddddddddmNNNNNNNNds:'         
        //              '-/osyhhddddddys+:'             
        //         `))
        console.log(chalk.bold.green('Sous Vide server is alive!'));
        console.log('Admin panel on:\nhttp://localhost:' + config.port + '\nhttp://' + await publicIp.v4() + ':' + config.port + '\nhttp://' + await internalIp.v4() + ':' + config.port);
    })();
});