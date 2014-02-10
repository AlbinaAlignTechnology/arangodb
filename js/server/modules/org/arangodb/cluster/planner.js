/*jslint indent: 2, nomen: true, maxlen: 120, sloppy: true, vars: true, white: true, plusplus: true, stupid: true */
/*global module, require, exports, ArangoAgency, SYS_TEST_PORT */

////////////////////////////////////////////////////////////////////////////////
/// @brief Cluster planning functionality
///
/// @file
///
/// DISCLAIMER
///
/// Copyright 2014 triagens GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is triAGENS GmbH, Cologne, Germany
///
/// @author Max Neunhoeffer
/// @author Copyright 2014, triAGENS GmbH, Cologne, Germany
////////////////////////////////////////////////////////////////////////////////

// -----------------------------------------------------------------------------
// --SECTION--                                             Planner functionality
// -----------------------------------------------------------------------------

// possible config attributes (for defaults see below):
//   .agencyPrefix            prefix for this cluster in agency
//   .numberOfAgents          number of agency servers
//   .numberOfDBservers       number of DB servers
//   .startSecondaries        boolean, whether or not to use secondaries
//   .numberOfCoordinators    number of coordinators
//   .DBserverIDs             a list of DBserver IDs, the defaults will
//                            be appended to this list here
//   .coordinatorIDs          a list of coordinator IDs, the defaults will
//                            be appended to this list here
//   .dispatchers             an object with a property for each dispatcher,
//                            the property name is the ID of the dispatcher
//                            and the value should be an object with
//                            at least the property "endpoint" containing
//                            the endpoint. Further optional properties
//                            are "avoidPorts" which is an object in which
//                            all port numbers that should not be used
//                            are bound to "true". 
//                            If `.dispatchers` is empty (no property), then an
//                            entry for the local arangod itself is
//                            automatically added.
//   .dataPath                a file system path to the directory in which
//                            all the data directories of agents or
//                            servers live, this can be relative or even
//                            empty, which is equivalent to "./", if it
//                            is relative, then it will be made into an
//                            absolute path by the dispatcher, using
//                            the parent directory of its own database
//                            directory
//   .logPath                 path where the log files are written, same
//                            comments as for .dataPath apply
//   .arangodPath             path to the arangod executable on
//                            all machines in the cluster, if this is empty
//                            the dispatcher will replace it with its own
//                            executable
//   .agentPath               path to the agent executable on 
//                            all machines in the cluster, if this is empty
//                            then the executable "etcd" in the same directory
//                            as the arangod executable of the dispatcher
//                            will be used.
// some port lists:
//   for these the following rules apply:
//     every list overwrites the default list
//     when running out of numbers the planner increments the last one
//       used by one for every port needed
//     
//   .agentExtPorts           a list port numbers to use for the
//                            external ports of agents,
//   .agentIntPorts           a list port numbers to use for the
//                            internal ports of agents,
//   .DBserverPorts           a list ports to try to use for DBservers
//   .coordinatorPorts        a list ports to try to use for coordinators
//  

var fs = require("fs");

// Our default configurations:

var PlannerLocalDefaults = {
  "agencyPrefix"            : "meier",
  "numberOfAgents"          : 3,
  "numberOfDBservers"       : 2,
  "startSecondaries"        : false,
  "numberOfCoordinators"    : 1,
  "DBserverIDs"             : ["Pavel", "Perry", "Pancho", "Paul", "Pierre",
                               "Pit", "Pia", "Pablo" ],
  "coordinatorIDs"          : ["Claus", "Chantalle", "Claire", "Claudia",
                               "Claas", "Clemens", "Chris" ],
  "dataPath"                : "",
  "logPath"                 : "",
  "arangodPath"             : "",
  "agentPath"               : "",
  "agentExtPorts"           : [4001],
  "agentIntPorts"           : [7001],
  "DBserverPorts"           : [8629],
  "coordinatorPorts"        : [8530],
  "dispatchers"             : {"me": {"endpoint": "tcp://localhost:"}}
};
  
// The following is just a further example:

var PlannerDistributedDefaults = {
  "agencyPrefix"            : "mueller",
  "numberOfAgents"          : 3,
  "numberOfDBservers"       : 3,
  "startSecondaries"        : false,
  "numberOfCoordinators"    : 3,
  "DBserverIDs"             : ["Pavel", "Perry", "Pancho", "Paul", "Pierre",
                               "Pit", "Pia", "Pablo" ],
  "coordinatorIDs"          : ["Claus", "Chantalle", "Claire", "Claudia",
                               "Claas", "Clemens", "Chris" ],
  "dataPath"                : "",
  "logPath"                 : "",
  "arangodPath"             : "bin/arangod",
  "agentPath"               : "bin/etcd",
  "agentExtPorts"           : [4001],
  "agentIntPorts"           : [7001],
  "DBserverPorts"           : [8629],
  "coordinatorPorts"        : [8530],
  "dispatchers"             : { "machine1": 
                                  { "endpoint": "tcp://machine1:8529",
                                    "avoidPorts": {} },
                                "machine2":
                                  { "id": "machine2", 
                                    "endpoint": "tcp://machine2:8529",
                                    "avoidPorts": {} },
                                "machine3":
                                  { "id": "machine3", 
                                    "endpoint": "tcp://machine3:8529",
                                    "avoidPorts": {} } }
};

// Some helpers using underscore:

var _ = require("underscore");

function objmap (o, f) {
  var r = {};
  var k = _.keys(o);
  var i;
  for (i = 0;i < k.length; i++) {
    r[k[i]] = f(o[k[i]]);
  }
  return r;
}

function copy (o) {
  if (_.isArray(o)) {
    return _.map(o,copy);
  }
  if (_.isObject(o)) {
    return objmap(o,copy);
  }
  return o;
}

// A class to find free ports:

function PortFinder (list, dispatcher) {
  if (!Array.isArray(list)) {
    throw "need a list as first argument";
  }
  if (typeof dispatcher !== "object" ||
      !dispatcher.hasOwnProperty("endpoint") ||
      !dispatcher.hasOwnProperty("id")) {
    throw 'need a dispatcher object as second argument';
  }
  if (!dispatcher.hasOwnProperty("avoidPorts")) {
    dispatcher.avoidPorts = {};
  }
  this.list = list;
  this.dispatcher = dispatcher;
  this.pos = 0;
  this.port = 0;
}

PortFinder.prototype.next = function () {
  while (true) {   // will be left by return when port is found
    if (this.pos < this.list.length) {
      this.port = this.list[this.pos++];
    }
    else if (this.port === 0) {
      this.port = Math.floor(Math.random()*(65536-1024))+1024;
    }
    else {
      this.port++;
      if (this.port > 65535) {
        this.port = 1024;
      }
    }
    // Check that port is available:
    if (!this.dispatcher.avoidPorts.hasOwnProperty(this.port)) {
      if (this.dispatcher.endpoint !== "tcp://localhost:" ||
          SYS_TEST_PORT("tcp://0.0.0.0:"+this.port)) {
        this.dispatcher.avoidPorts[this.port] = true;  // do not use it again
        return this.port;
      }
    }
  }
};
 
function exchangePort (endpoint, newport) {
  var pos = endpoint.lastIndexOf(":");
  if (pos < 0) {
    return endpoint+":"+newport;
  }
  return endpoint.substr(0,pos+1)+newport;
}

// The following function merges default configurations and user configuration.

function fillConfigWithDefaults (config, defaultConfig) {
  var appendAttributes = {"DBserverIDs":true, "coordinatorIDs":true};
  var n;
  for (n in defaultConfig) {
    if (defaultConfig.hasOwnProperty(n)) {
      if (appendAttributes.hasOwnProperty(n)) {
        if (!config.hasOwnProperty(n)) {
          config[n] = copy(defaultConfig[n]);
        }
        else {
          config[n].concat(defaultConfig[n]);
        }
      }
      else {
        if (!config.hasOwnProperty(n)) {
          config[n] = copy(defaultConfig[n]);
        }
      }
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
/// @fn JSF_Cluster_Planner_Constructor
/// @brief the cluster planner constructor
///
/// @FUN{new Planner(@FA{userConfig})}
///
/// This constructor builds a cluster planner object. The one and only
/// argument is an object that can have the following properties:
///
///   - `numberOfAgents`: the number of agents in the agency,
///     usually there is no reason to deviate from the default of 3
///   - `numberOfDBservers`: the number of DBservers in the
///     cluster.
///   - `numberOfCoordinators`: the number of coordinators in the cluster.
///
/// All these values have default values. Here is the current set of
/// default values:
/// 
///
////////////////////////////////////////////////////////////////////////////////

function Planner (userConfig) {
  "use strict";
  if (typeof userConfig !== "object") {
    throw "userConfig must be an object";
  }
  this.config = copy(userConfig);
  fillConfigWithDefaults(this.config, PlannerLocalDefaults);
  this.commands = [];
  this.makePlan();
}

Planner.prototype.makePlan = function() {
  // This sets up the plan for the cluster according to the options

  var config = this.config;
  var dispatchers = this.dispatchers = copy(config.dispatchers);

  var id;
  for (id in dispatchers) {
    if (dispatchers.hasOwnProperty(id)) {
      dispatchers[id].id = id;
      if (!dispatchers[id].hasOwnProperty("avoidPorts")) {
        dispatchers[id].avoidPorts = {};
      }
    }
  }
  // If no dispatcher is there, configure a local one (ourselves):
  if (Object.keys(dispatchers).length === 0) {
    dispatchers.me = { "id": "me", "endpoint": "tcp://localhost:", 
                       "avoidPorts": {} };
    config.onlyLocalhost = true;
  }
  else {
    config.onlyLocalhost = false;
    var k = Object.keys(dispatchers);
    if (k.length === 1 && 
        dispatchers[k[0]].endpoint.substr(0,16) === "tcp://localhost:") {
      config.onlyLocalhost = true;
    }
  }
  var dispList = Object.keys(dispatchers);

  var pf,pf2;   // lists of port finder objects
  var i;

  // Distribute agents to dispatchers (round robin, choosing ports)
  var d = 0;
  var agents = [];
  pf = [];   // will be filled lazily
  pf2 = [];  // will be filled lazily
  for (i = 0; i < config.numberOfAgents; i++) {
    // Find two ports:
    if (!pf.hasOwnProperty(d)) {
      pf[d] = new PortFinder(config.agentExtPorts, dispatchers[dispList[d]]);
      pf2[d] = new PortFinder(config.agentIntPorts, dispatchers[dispList[d]]);
    }
    agents.push({"dispatcher":dispList[d],
                 "extPort":pf[d].next(),
                 "intPort":pf2[d].next()});
    if (++d >= dispList.length) {
      d = 0;
    }
  }

  // Distribute coordinators to dispatchers
  var coordinators = [];
  pf = [];
  d = 0;
  for (i = 0; i < config.numberOfCoordinators; i++) {
    if (!pf.hasOwnProperty(d)) {
      pf[d] = new PortFinder(config.coordinatorPorts, dispatchers[dispList[d]]);
    }
    if (!config.coordinatorIDs.hasOwnProperty(i)) {
      config.coordinatorIDs[i] = "Coordinator"+i;
    }
    coordinators.push({"id":config.coordinatorIDs[i],
                       "dispatcher":dispList[d],
                       "port":pf[d].next()});
    if (++d >= dispList.length) {
      d = 0;
    }
  }

  // Distribute DBservers to dispatchers (secondaries if wanted)
  var DBservers = [];
  pf = [];
  d = 0;
  for (i = 0; i < config.numberOfDBservers; i++) {
    if (!pf.hasOwnProperty(d)) {
      pf[d] = new PortFinder(config.DBserverPorts, dispatchers[dispList[d]]);
    }
    if (!config.DBserverIDs.hasOwnProperty(i)) {
      config.DBserverIDs[i] = "Primary"+i;
    }
    DBservers.push({"id":config.DBserverIDs[i],
                    "dispatcher":dispList[d],
                    "port":pf[d].next()});
    if (++d >= dispList.length) {
      d = 0;
    }
  }

  // Store this plan in object:
  this.coordinators = coordinators;
  this.DBservers = DBservers;
  this.agents = agents;
  var launchers = {};
  for (i = 0; i < dispList.length; i++) {
    launchers[dispList[i]] = { "DBservers": [], 
                               "Coordinators": [] };
  }

  // Set up agency data:
  var agencyData = this.agencyData = {};
  var prefix = agencyData[config.agencyPrefix] = {};
  var tmp;

  // First the Target, we collect Launchers information at the same time:
  tmp = prefix.Target = {};
  tmp.Lock = '"UNLOCKED"';
  tmp.Version = '"1"';
  var dbs = tmp.DBServers = {};
  var map = tmp.MapIDToEndpoint = {};
  var s;
  for (i = 0; i < DBservers.length; i++) {
    s = DBservers[i];
    dbs[s.id] = map[s.id] 
           = '"'+exchangePort(dispatchers[s.dispatcher].endpoint,s.port)+'"';
    launchers[s.dispatcher].DBservers.push(s.id);
  }
  var coo = tmp.Coordinators = {};
  for (i = 0; i < coordinators.length; i++) {
    s = coordinators[i];
    coo[s.id] = map[s.id] 
           = '"'+exchangePort(dispatchers[s.dispatcher].endpoint,s.port)+'"';
    launchers[s.dispatcher].Coordinators.push(s.id);
  }
  tmp.Databases = { "_system" : '{"name":"_system"}' };
  tmp.Collections = { "_system" : {} };

  // Now Plan:
  prefix.Plan = copy(tmp);
  delete prefix.Plan.MapIDToEndpoint;

  // Now Current:
  prefix.Current = { "Lock"             : '"UNLOCKED"',
                     "Version"          : '"1"',
                     "DBservers"        : {},
                     "Coordinators"     : {},
                     "Databases"        : {"_system":{}},
                     "Collections"      : {"_system":{}},
                     "ServersRegistered": {"Version":'"1"'},
                     "ShardsCopied"     : {} };

  // Now Sync:
  prefix.Sync = { "ServerStates"       : {},
                  "Problems"           : {},
                  "LatestID"           : '"0"',
                  "Commands"           : {},
                  "HeartbeatIntervalMs": '1000' };
  tmp = prefix.Sync.Commands;
  for (i = 0; i < DBservers; i++) {
    tmp[DBservers[i].id] = '"SERVE"';
  }

  // Finally Launchers:
  prefix.Launchers = objmap(launchers, JSON.stringify);

  // make commands
  tmp = this.commands = [];
  var tmp2,j;
  for (i = 0; i < agents.length; i++) {
    tmp2 = { "action" : "startAgent", "dispatcher": agents[i].dispatcher,
             "extPort": agents[i].extPort,
             "intPort": agents[i].intPort,
             "peers": [],
             "agencyPrefix": config.agencyPrefix,
             "dataPath": config.dataPath,
             "logPath": config.logPath,
             "agentPath": config.agentPath,
             "onlyLocalhost": config.onlyLocalhost };
    for (j = 0; j < i; j++) {
      var ep = dispatchers[agents[j].dispatcher].endpoint;
      tmp2.peers.push( exchangePort( ep, agents[j].intPort ) );
    }
    tmp.push(tmp2);
  }
  var agencyPos = { "agencyPrefix": config.agencyPrefix,
                    "endpoints": agents.map(function(a) {
                        return exchangePort(dispatchers[a.dispatcher].endpoint,
                                            a.extPort);}) };
  tmp.push( { "action": "sendConfiguration", 
              "agency": agencyPos,
              "data": agencyData } );
  for (i = 0; i < dispList.length; i++) {
    tmp.push( { "action": "startServers", "dispatcher": dispList[i],
                "DBservers": copy(launchers[dispList[i]].DBservers),
                "Coordinators": copy(launchers[dispList[i]].Coordinators),
                "name": dispList[i], 
                "dataPath": config.dataPath,
                "logPath": config.logPath,
                "arangodPath": config.arangodPath,
                "onlyLocalhost": config.onlyLocalhost,
                "agency": copy(agencyPos) } );
  }
  this.myname = "me";
};

Planner.prototype.getPlan = function() {
  // Computes the dispatcher commands and returns them as JSON
  return { "dispatchers": this.dispatchers,
           "commands": this.commands };
};

exports.PortFinder = PortFinder;
exports.Planner = Planner;
exports.exchangePort = exchangePort;

// -----------------------------------------------------------------------------
// --SECTION--                                                       END-OF-FILE
// -----------------------------------------------------------------------------

/// Local Variables:
/// mode: outline-minor
/// outline-regexp: "/// @brief\\|/// @addtogroup\\|/// @page\\|// --SECTION--\\|/// @\\}\\|/\\*jslint"
/// End:
