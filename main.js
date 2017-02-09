/**
 *
 * wiffi-wz adapter
 *
 *
 *  file io-package.json comments:
 *
 *  {
 *      "common": {
 *          "name":         "wiffi-wz",
 *          "version":      "0.2.0",
 *          "title":        "Wiffi-wz Adapter",
 *          "authors":  [
 *              "Christian Vorholt <chvorholt@gmail.com>"
 *          ]
 *          "desc":         "Adapter f�r den Wiffi-wz",
 *          "platform":     "Javascript/Node.js",
 *          "mode":         "daemon",                   // possible values "daemon", "schedule", "subscribe"
 *          "schedule":     "0 0 * * *"                 // cron-style schedule. Only needed if mode=schedule
 *          "loglevel":     "info"                      // Adapters Log Level
 *      },
 *      "native": {                                     // the native object is available via adapter.config in your adapters code - use it for configuration
 *        "local_server_ip": "0.0.0.0",
 *        "local_server_port": 8181,
 *        "devices": [
 *              {"ip" : "0.0.0.0", "room": ""}
 *        ],
 *        "wiffi_target": "IOBroker",
 *        "wiffi_target_ccu_ip": "homematic-ccu2",
 *        "exp_red_led": true
 *      }
 *  }
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.wiffi-wz.0
var adapter = utils.adapter('wiffi-wz');
var channels    = {};

// triggered when the adapter is installed
adapter.on('install', function () {
  // create a node for subsequent wiffis
  adapter.createDevice('root', {});
});

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
  try {
    adapter.log.info('cleaned everything up...');
      callback();
  } catch (e) {
      callback();
  }
});

// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
  // Warning, obj can be null if it was deleted
  adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));
});

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
  // Warning, state can be null if it was deleted
  adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

  // you can use the ack flag to detect if it is status (true) or command (false)
  if (state && !state.ack) {
    adapter.log.debug('ack is not set!');
  }
});

// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
  if (typeof obj == 'object' && obj.message) {
    if (obj.command == 'send') {
      // e.g. send email or pushover or whatever
      console.log('send command');

      // Send response in callback if required
      if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    }
  }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
  // make sure that the root node really exists
  adapter.getObject(adapter.namespace + '.root', function (err, obj) {
    if (!obj || !obj.common || !obj.common.name) {
      adapter.createDevice('root', {}, function () {
        main();
      });
    } else {
      main();
    }
  });
});

function main() {

  // The adapters config (in the instance object everything under the attribute "native") is accessible via
  // adapter.config:
  adapter.log.info('Opening local server on ' + adapter.config.local_server_ip + ':' + adapter.config.local_server_port);

  // check setup of all wiffis
  syncConfig();

  // in this wiffi-wz all states changes inside the adapters namespace are subscribed
  adapter.subscribeStates('*');

  // start socket listening on port 8181
  console.log("Opening socket ...");
  openSocket();
}

function openSocket() {
  var net = require('net');
  var host = adapter.config.local_server_ip;
  var port = adapter.config.local_server_port;

  // Create a server instance, and chain the listen function to it
  // The function passed to net.createServer() becomes the event handler for the 'connection' event
  // The sock object the callback function receives UNIQUE for each connection
  net.createServer(function(sock) {

    // We have a connection - a socket object is assigned to the connection automatically
    console.log('CONNECTED: ' + sock.remoteAddress +':'+ sock.remotePort);

    var maxBufferSize = 20000; // the buffer should not be bigger than this number to prevent DOS attacks
    var buffer = '';
    var remote_address = sock.remoteAddress;

    sock.on('data', function(data) {
      var prev = 0;
      var error = false;
      var next;
      var jsonContent; // holds the parsed data

      data = data.toString('utf8'); // assuming utf8 data...
      // look for the terminator that terminates each Wiffi-wz JSON package
      while ((next = data.indexOf('\u0003', prev)) > -1) {
        buffer += data.substring(prev, next);

        // remove terminator from buffer
        buffer    = buffer.substr(0,buffer.length);

        // found terminator message should be complete
        adapter.log.debug('Full message: ' + buffer);
        adapter.log.info('Received JSON data from Wiffi-wz');

        // try to parse the JSON object and set states
        try {
          jsonContent = JSON.parse(buffer);
        }
        catch(e) {
          error = true;
          adapter.log.error('Failed parsing JSON data from Wiffi-wz: ' + e.message)
        }

        if(!error) {
          // parsing successful, set the states

          // get Wiffi-ip from JSON data
          var wz_ip = jsonContent.vars[0].value;

          // check if wiffi-ip is consistent
          if(wz_ip && remote_address != wz_ip) {
            adapter.log.warn('Wiffi data received from ' + remote_address + ', but Wiffi send address' +
              wz_ip);
            // should we allow that this?
          }

          // trust the ip the wiffi told us
          var wiffi = [];
          for (var i = 0, len = adapter.config.devices.length; i < len; i++) {
            if(adapter.config.devices[i].ip === wz_ip) {
              // found a wiffi
              wiffi.push({id: wz_ip.replace(/[.\s]+/g, '_'), ip: wz_ip});
            }
          }

          if (wiffi.length === 0) {
            adapter.log.warn('Received data from unregistered wiffi with ip ' + wz_ip);
          } else if (wiffi.length === 1) {
            // wiffi found
            setStatesFromJSON(jsonContent, wiffi[0], function (err, result) {
              // error handling of set states should be placed here
            });
          } else {
            adapter.log.error('There are multiple wiffis registered with the ip' + wz_ip);
          }
        }

        buffer = '';
        prev = next + 1;
      }
      buffer += data.substring(prev);

      // check if the buffer is larger than the allowed maximum
      if(buffer.length > maxBufferSize) {
          // clear buffer
          buffer = '';
          adapter.log.warn('JSON larger than allowed size of ' + maxBufferSize + ', clearing buffer');
      }
    });

    // Add a 'close' event handler to this instance of socket
    sock.on('close', function(data) {
      console.log('CLOSED: ' + sock.remoteAddress +' '+ sock.remotePort);
    });

  }).listen(port, host);

  console.log('Server listening on ' + host +':'+ port);
}

function syncConfig() {
  channels = {};

  adapter.getDevices(function (err, devices) {
    if (devices && devices.length) {
      // go through all devices
      for (var i = 0; i < devices.length; i++) {

        adapter.getChannelsOf(devices[i].common.name, function (err, _channels) {
          var configToDelete = [];
          var configToAdd    = [];
          var k;
          // find all devices
          if (adapter.config.devices) {
            for (k = 0; k < adapter.config.devices.length; k++) {
              configToAdd.push(adapter.config.devices[k].ip);
            }
          }

          if (_channels) {
            for (var j = 0; j < _channels.length; j++) {
              var ip = _channels[j].native.ip;
              var id = ip.replace(/[.\s]+/g, '_');
              var pos = configToAdd.indexOf(ip);
              if (pos !== -1) {
                configToAdd.splice(pos, 1);
              } else {
                // mark these channels for deletion
                configToDelete.push(ip);
              }
            }
          }

          // create new states for these devices
          if (configToAdd.length) {
            for (var r = 0; r < adapter.config.devices.length; r++) {
              if (adapter.config.devices[r].ip && configToAdd.indexOf(adapter.config.devices[r].ip) !== -1) {
                addChannel(adapter.config.devices[r].name, adapter.config.devices[r].ip, adapter.config.devices[r].room)
              }
            }
          }
          if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {
              if (configToDelete[e]) {
                var _id = configToDelete[e].replace(/[.\s]+/g, '_');
                adapter.deleteChannelFromEnum('room', 'root', _id);
                adapter.deleteChannel('root', _id);
              }
            }
          }
        });
      }
    } else {
      for (var r = 0; r < adapter.config.devices.length; r++) {
        if (!adapter.config.devices[r].ip) continue;
        addChannel(adapter.config.devices[r].name, adapter.config.devices[r].ip, adapter.config.devices[r].room)
      }
    }
  });
}

// create all states
function createChannel(name, ip, room, callback) {
  var states = {
    'wz_ip': {
      type: 'string',
      read: true,
      write: false,
      role: 'info',
      value: ip,
      desc: 'ip-address'
    },
    'wz_co2': {
      type: 'number',
      read: true,
      write: false,
      unit: '%',
      min: 0,
      max: 100,
      role: 'sensor.co2',
      desc: 'air quality sensor'
    },
    'wz_temp': {
      type: 'number',
      read: true,
      write: false,
      unit: '°C',
      min: -10,
      max: 60,
      role: 'sensor.temperature',
      desc: 'temperature sensor'
    },
    'wz_feuchte': {
      type: 'number',
      read: true,
      write: false,
      unit: '%',
      min: 0,
      max: 100,
      role: 'sensor.humidity',
      desc: 'relative humidity sensor'
    },
    'wz_noise': {
      def: false,
      type: 'boolean',
      read: true,
      write: false,
      role: 'indicator',
      desc: 'noise sensor'
    },
    'wz_motion_left': {
      def: false,
      type: 'boolean',
      read: true,
      write: false,
      role: 'sensor.motion',
      desc: 'motion detector left side'
    },
    'wz_motion_right': {
      def: false,
      type: 'boolean',
      read: true,
      write: false,
      role: 'sensor.motion',
      desc: 'motion detector right side'
    },
    'wz_lux': {
      type: 'number',
      read: true,
      write: false,
      min: 0,
      max: 100000,
      unit: 'lux',
      role: 'sensor.luxmeter',
      desc: 'luxmeter'
    },
    'wz_baro': {
      type: 'number',
      read: true,
      write: false,
      min: 300,
      max: 1100,
      unit: 'hPa',
      role: 'sensor.barometer',
      desc: 'barometric sensor'
    },
    'wz_elevation': {
      type: 'number',
      read: true,
      write: false,
      min: 0,
      max: 360,
      unit: '°',
      role: 'sensor.elevation',
      desc: 'calculated elevation'
    },
    'wz_azimut': {
      type: 'number',
      read: true,
      write: false,
      min: 0,
      max: 360,
      unit: '°',
      role: 'sensor.azimut',
      desc: 'calculated azimut'
    },
    'wz_buzzer': {
      def: false,
      type: 'boolean',
      read: true,
      write: true,
      role: 'alarm',
      desc: 'integrated buzzer'
    }
  };

  var states_list = [];
  for (var state in states) {
    states_list.push(state);
  }
  // use ip-address as id
  var id = ip.replace(/[.\s]+/g, '_');

  // create channel for the wiffi
  adapter.createChannel('root', id,
    {
      role: 'sensor',
      name: name || ip
    },{
      ip: ip
    }, function (err, obj) {
      if (callback) callback(err, obj);
    });

  // add the wiffi to the corresponding room enum
  if (room) {
    adapter.addChannelToEnum('room', room, 'root', id);
  }

  // create all states
  for (var j = 0; j < states_list.length; j++) {
    adapter.createState('root', id, states_list[j], states[states_list[j]]);
  }
}

// add channels
function addChannel(name, ip, room, callback) {
  adapter.getObject('root', function (err, obj) {
    if (err || !obj) {
      // if root does not exist, channel will not be created
      adapter.createDevice('root', [], function () {
        createChannel(name, ip, room, callback);
      });
    } else {
      createChannel(name, ip, room, callback);
    }
  });
}

// set states from the received JSON
function setStatesFromJSON(curStates, wiffi, callback) {
  var arrVar; // hold the array with the wiffi-wz data objects

  arrVar = curStates.vars;

  // go through the array and set states
  for(var i=0;i<arrVar.length;i++) {
    adapter.setState({device: 'root', channel: wiffi.id, state: arrVar[i].homematic_name}, {val: arrVar[i].value, ack: true});
  }

  adapter.log.info('Wiffi-wz states of wiffi ' + wiffi.ip + ' updated.');
  callback(null, true)
}
