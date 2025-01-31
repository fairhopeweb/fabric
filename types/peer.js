'use strict';

// Constants
const {
  P2P_IDENT_REQUEST,
  P2P_IDENT_RESPONSE,
  P2P_ROOT,
  P2P_PING,
  P2P_PONG,
  P2P_START_CHAIN,
  P2P_INSTRUCTION,
  P2P_BASE_MESSAGE,
  P2P_STATE_COMMITTMENT,
  P2P_STATE_CHANGE,
  P2P_STATE_ROOT,
  ZERO_LENGTH_PLAINTEXT
} = require('../constants');

// Internals
const net = require('net');
const crypto = require('crypto');
const stream = require('stream');

// Dependencies
const merge = require('lodash.merge');
// const upnp = require('nat-upnp');

// Fabric Types
const Actor = require('./actor');
const Key = require('./key');
const Machine = require('./machine');
const Message = require('./message');
const Session = require('./session');
const Reader = require('./reader');
const Wallet = require('./wallet');

/**
 * An in-memory representation of a node in our network.
 */
class Peer extends Actor {
  /**
   * Create an instance of {@link Peer}.
   * @param {Object} [config] Initialization Vector for this peer.
   * @param {Boolean} [config.listen] Whether or not to listen for connections.
   * @param {Boolean} [config.upnp] Whether or not to use UPNP for automatic configuration.
   * @param {Number} [config.port=7777] Port to use for P2P connections.
   * @param {Array} [config.peers=[]] List of initial peers.
   */
  constructor (config = {}) {
    super(config);

    this.name = 'Peer';
    this.settings = merge({
      address: '0.0.0.0',
      network: 'regtest',
      networking: true,
      listen: true,
      peers: [],
      port: 7777,
      upnp: false,
      key: {}
    }, config);

    // Network Internals
    this.upnp = null;
    this.server = net.createServer(this._handleConnection.bind(this));
    this.stream = new stream.Transform({
      transform (chunk, encoding, callback) {
        // TODO: parse as encrypted data
        callback(null, chunk);
      }
    });

    this.key = new Key(this.settings.key);
    this.wallet = new Wallet(this.settings.key);

    // this.hex = this.key.public.encodeCompressed('hex');
    // this.pkh = crypto.createHash('sha256').update(this.hex).digest('hex');

    // Public Details
    this.public = {
      ip: null,
      port: this.settings.port
    };

    // Internal properties
    this.chains = {};
    this.connections = {};
    this.peers = {};
    this.memory = {};
    this.handlers = {};
    this.messages = new Set();

    // Internal Stack Machine
    this.machine = new Machine();

    this.meta = {
      messages: {
        inbound: 0,
        outbound: 0
      }
    };

    this._state = {
      peers: {},
      chains: {},
      connections: {},
      status: 'sleeping'
    };

    return this;
  }

  get id () {
    return this.key.pubkey;
  }

  get pubkeyhash () {
    // TODO: switch to child pubkey
    // path: m/7777'/0'/0/0
    return this.key.pubkeyhash;
  }

  get state () {
    // TODO: use Proxy
    return Object.assign({}, this._state);
  }

  get address () {
    return this.settings.interface || this.settings.address;
  }

  get interface () {
    return this.settings.interface || this.settings.address;
  }

  get port () {
    return this.settings.port || 7777;
  }

  set state (value) {
    this._state = value;
  }

  /**
   * Start the Peer.
   */
  async start () {
    let address = null;

    this.emit('log', 'Peer starting...');

    if (this.settings.upnp) {
      this.upnp = upnp.createClient();
    }

    this.emit('log', 'Wallet starting...');

    try {
      await this.wallet.start();
    } catch (exception) {
      this.emit('error', `Could not start wallet: ${exception}`);
    }

    if (this.settings.listen) {
      this.emit('log', 'Listener starting...');

      try {
        address = await this.listen();
        this.emit('log', 'Listener started!');
      } catch (exception) {
        this.emit('error', 'Could not listen:', exception);
      }
    }

    if (this.settings.networking) {
      this.emit('warning', `Networking enabled.  Connecting to peers: ${JSON.stringify(this.settings.peers)}`);
      for (const candidate of this.settings.peers) {
        this._connect(candidate);
      }
    }

    this.emit('ready', {
      id: this.id,
      address: address,
      pubkey: this.key.pubkey
    });

    return this;
  }

  /**
   * Stop the peer.
   */
  async stop () {
    const peer = this;

    // Alert listeners
    peer.emit('log', 'Peer stopping...');

    if (peer.settings.upnp && peer.upnp) {
      peer.upnp.close();
    }

    for (const id in peer.connections) {
      peer.emit('log', `Closing connection: ${id}`);
      const connection = peer.connections[id];
      const closer = async function () {
        return new Promise((resolve, reject) => {
          // Give socket a timeout to close cleanly, destroy if failed
          let deadline = setTimeout(function () {
            peer.emit('warning', `[FABRIC:PEER] end() timed out for peer "${id}" so calling destroy...`);
            connection.destroy();
            resolve();
          }, 5000);

          // TODO: notify remote peer of closure
          // Use end(SOME_CLOSE_MESSAGE, ...)
          return connection.end(function socketClosed (error) {
            if (error) return reject(error);
            clearTimeout(deadline);
            resolve();
          });
        });
      }
      await closer();
    }

    const terminator = async function () {
      return new Promise((resolve, reject) => {
        if (!peer.server.address()) return resolve();
        return peer.server.close(function serverClosed (error) {
          if (error) return reject(error);
          resolve();
        });
      });
    }

    await terminator();

    return this;
  }

  async _setState (value) {
    if (!value) return new Error('You must provide a State to set the value to.');
    this.state.state = value;
    return this.state.state;
  }

  // TODO: use in _connect
  async _sessionStart (socket, target) {
    const self = this;
    const address = `${target.address}:${target.port}`;

    self.emit('debug', `Starting session with address: ${target.pubkey}@${address}`);
    self.connections[address].session = new Session({ recipient: target.pubkey });
    await self.connections[address].session.start();

    self.emit('debug', `Session created: ${JSON.stringify(self.connections[address].session)}`);

    // First time seeing our local address, use it
    // TODO: evaluate trust model
    if (!self.public.ip) {
      self.public.ip = socket.localAddress;
      self.emit('log', `Local socket was null, changed to: ${self.public.ip}`);
    }

    // TODO: consolidate with similar _handleConnection segment
    // TODO: check peer ID, eject if self or known

    // TODO re-enable (disabled to reduce spammy messaging)
    // /*
    // TODO: re-evaluate use of IdentityRequest
    // const vector = ['IdentityRequest', self.id];
    const vector = ['StartSession', JSON.stringify({
      id: self.connections[address].session.id,
      identity: self.id,
      advertise: `${self.key.pubkey}@${self.public.ip}:${self.public.port}`,
      signature: self.connections[address].session.key._sign(self.id)
    })];

    const message = Message.fromVector(vector);

    if (!socket.writable) {
      self.emit('error', `Socket is not writable.`);
      return false;
    }

    self.sendToSocket(address, message);

    // Emit notification of a newly opened connection
    self.emit('connections:open', {
      address: address,
      status: 'unauthenticated',
      initiator: true
    });

    if (self.settings.verbosity >= 4) console.log('[FABRIC:PEER]', `Connection to ${address} established!`);
  }

  async _processCompleteDataPacket (socket, address, data) {
    // Constants
    const self = this;
    // TODO: actually decrypt packet
    const decrypted = socket.session.decrypt(data);

    // Variables
    let message = null;

    try {
      message = self._parseMessage(decrypted);
    } catch (exception) {
      console.error('[FABRIC:PEER]', 'Could not parse inbound messsage:', exception);
    }

    // disconnect from any peer sending invalid messages
    if (!message) return socket.destroy();

    const response = await self._handleMessage({
      message: message,
      origin: address,
      peer: {
        address: address,
        id: socket.id
      }
    });

    if (response) {
      self.meta.messages.outbound++;
      self.sendToSocket(address, response);
    }
  }

  async _handleSocketData (socket, address, data) {
    const self = this;
    if (self.settings.verbosity >= 5) console.log('[FABRIC:PEER]', 'Received data from peer:', data);

    if (!socket.session) {
      self.emit('error', `Received data on socket without a session!  Violator: ${address}`);
      return false;
    }

    socket._reader._addData(data);
  }

  _connect (address) {
    let self = this;
    let parts = address.split(':');
    let known = Object.keys(self.connections);
    let keyparts = parts[0].split('@');
    let target = {
      pubkey: null,
      address: null,
      port: null
    };

    if (keyparts.length === 2) {
      target.pubkey = keyparts[0];
      target.address = keyparts[1];
      target.port = parts[1];
    } else {
      target.address = parts[0];
      target.port = parts[1];
    }

    if (target.pubkey === self.id) return this.emit('error', 'Cannot connect to self.');

    const authority = `${target.address}:${target.port}`;

    this.emit('log', `Connecting to address: ${authority}`);

    if (parts.length !== 2) return console.debug('Invalid address:', address);
    if (known.includes(authority)) return self.connections[authority];

    // TODO: refactor to use local functions + specific unbindings
    try {
      self.connections[authority] = new net.Socket();
      self.connections[authority]._reader = new Reader();
      self.connections[authority]._reader.on('debug', function (msg) {
        self.emit('debug', msg);
      });

      self.connections[authority]._reader.on('message', function (msg) {
        self._processCompleteDataPacket.apply(self, [ self.connections[authority], authority, msg ]);
      });

      self.connections[authority].on('error', function (err) {
        const text = `could not connect to peer ${authority} — Reason: ${err}`;
        self.emit('connection:error', {
          message: text
        });
        // console.debug('[PEER]', `could not connect to peer ${authority} — Reason:`, err);
      });

      self.connections[authority].on('close', function _handleSocketClose (err) {
        if (err) self.debug('socket closed on error:', err);
        if (err) self.emit('log', `socket closed on error: ${err}`);

        self.emit('warning', `Connection closed: ${authority}`);

        self.connections[authority].removeAllListeners();

        // TODO: consider using `process.nextTick` to only clean up after event?
        delete self.connections[authority];
        self.emit('connections:close', {
          address: authority
        });
      });

      // TODO: unify as _dataHandler
      self.connections[authority].on('data', async function peerDataHandler (data) {
        self._handleSocketData.apply(self, [ this, authority, data ]);
      });

      self.emit('connection', {
        id: authority
      });

      self.emit('log', `Starting connection to address: ${authority}`);

      // TODO: replace with handshake
      // NOTE: the handler is only called once per connection!
      self.connections[authority].connect(target.port, target.address, async function connectionAttemptComplete (error) {
        if (error) return new Error(`Could not establish connection: ${error}`);
        await self._sessionStart.apply(self, [ this, target ]);
        self._maintainConnection(authority);
      });
    } catch (E) {
      self.log('[PEER]', 'failed to connect:', E);
    }

    return self.connections[authority];
  }

  _disconnect (address) {
    if (!this.connections[address]) return false;

    // Halt any heartbeat
    if (this.connections[address].heartbeat) {
      clearInterval(this.connections[address].heartbeat);
    }

    // Destroy the connection
    this.connections[address].destroy();

    // Remove connection from map
    delete this.connections[address];
  }

  _parseMessage (data) {
    if (!data) return false;
    if (this.settings.verbosity >= 5) console.log('[FABRIC:PEER]', 'Parsing message:', data);

    // Variables
    let message = null;

    try {
      message = Message.fromRaw(data);
    } catch (exception) {
      this.emit('debug', `[FABRIC:PEER] error parsing message: ${exception}`);
    }

    if (this.settings.verbosity >= 5) console.log('[FABRIC:PEER]', 'Parsed message into:', message.type, message.data);
    return message;
  }

  async _handleConnection (socket) {
    const self = this;
    const address = [socket.remoteAddress, socket.remotePort].join(':');

    self.emit('log', `[FABRIC:PEER] [0x${self.id}] Incoming connection from address: ${address}`);

    self.emit('connections:open', {
      address: address,
      status: 'connected',
      initiator: false
    });

    // TODO: use known key
    socket.session = new Session();

    socket.on('close', function terminate () {
      self.emit('log', `connection closed: ${address}`);
      self.emit('connections:close', { address: address });
      self._disconnect(address);
    });

    socket.on('data', function inboundPeerHandler (data) {
      try {
        self._handleSocketData.apply(self, [ socket, address, data ]);
      } catch (exception) {
        self.emit('error', `Could not handle socket data: ${exception}`);
      }
    });

    // add this socket to the list of known connections
    this.connections[address] = socket;
    this.connections[address]._reader = new Reader();
    self.connections[address]._reader.on('debug', function (msg) {
      self.emit('debug', msg);
    });

    this.connections[address]._reader.on('message', function (msg) {
      self._processCompleteDataPacket.apply(self, [ self.connections[address], address, msg ]);
    });

    self._maintainConnection(address);
  }

  _maintainConnection (address) {
    const peer = this;
    if (!peer.connections[address]) return new Error(`Connection for address "${address}" does not exist.`);
    /* peer.connections[address]._player = setInterval(function () {
      peer._pingConnection.apply(peer, [ address ]);
    }, 60000); */
  }

  _pingConnection (address) {
    const ping = Message.fromVector(['Ping', `${Date.now().toString()}`]);

    try {
      this.sendToSocket(address, ping);
    } catch (exception) {
      this.emit('error', `Couldn't deliver message to socket: ${exception}`);
    }
  }

  _updateLiveness (address) {
    // Return Error if no connection
    if (!this.connections[address]) {
      const error = `No connection for address: ${address}`;
      this.emit('error', error);
      return new Error(error);
    }

    // Set the _lastMessage property
    this.connections[address]._lastMessage = Date.now();

    // Make chainable
    return this;
  }

  _registerHandler (type, method) {
    if (this.handlers[type]) return new Error(`Handler for method "${type}" is already registered.`);
    this.handlers[type] = method.bind(this);
    return this.handlers[type];
  }

  _registerPeer (peer) {
    if (this.settings.verbosity >= 6) console.warn('[AUDIT]', 'Registering peer:', peer);
    let self = this;

    if (!peer) return false;
    if (!peer.id) {
      self.log(`Peer attribute 'id' is required.`);
      return false;
    }

    self.peers[peer.id] = peer;

    // console.log('[FABRIC:PEER]', `[@ID:$${self.id}]`, 'Peer registered:', peer);
    // console.log('[FABRIC:PEER]', `[@ID:$${self.id}]`, 'Peer list:', self.peers);

    self.emit('peer', peer);

    // TODO: document peer announcement
    // TODO: eliminate use of JSON in messaging
    const announcement = Message.fromVector(['PeerCandidate', JSON.stringify(peer)]);

    try {
      self.relayFrom(peer.id, announcement);
    } catch (exception) {
      self.emit('error', `Could not relay peer registration: ${exception}`);
    }

    return true;
  }

  async _requestStateFromAllPeers () {
    const message = Message.fromVector(['StateRequest']);
    this.broadcast(message);
  }

  async _handleMessage (packet) {
    if (!packet) return false;

    // Constants
    const self = this;
    const message = packet.message;
    const origin = packet.origin;

    // Variables
    let relay = false;
    let response = null;

    this._updateLiveness(origin);

    if (!message) return this.emit('error', `Hard failure: ${packet}`);
    if (this.messages.has(message.id)) {
      // this.emit('debug', `Received duplicate message ${message.id} from [${origin}] in packet: ${JSON.stringify(packet, null, '  ')}`);
      return false;
    } else {
      this.memory[message.id] = message;
      this.messages.add(message.id);
    }

    this.emit('log', `Evaluting message with purported type "${message.type}":`);

    // Build a response to various message types
    switch (message.type) {
      case 'ChatMessage':
        relay = true;
        this.emit('debug', `Message: ${JSON.stringify({
          type: message.type,
          data: message.data,
          size: message.data.length
        }, null, '  ')}`);
        this.emit('debug', `Data (${typeof message.data}): \n\t${message.data}`);

        try {
          const data = JSON.parse(message.data);
          this.emit('debug', `Parsed (${typeof data}): ${JSON.stringify(data, null, '  ')}`);
          this.emit('log', `[${data.object.created}] @${data.actor}: ${data.object.content}`);
          this.emit('message', message.data);
        } catch (exception) {
          this.emit('error', `Could not process ChatMessage: ${exception}`);
        }
        break;
      case 'Generic':
        relay = true;
        break;
      case 'Ping':
        response = Message.fromVector(['Pong', message.id]);
        break;
      case 'Pong':
        // self.emit('message', `Received Pong: ${message}`);
        break;
      case 'StartChain':
        break;
      case 'GenericMessage':
        console.warn('[FABRIC:PEER]', 'Received Generic Message:', message.data);
        relay = true;
        break;
      case 'IdentityRequest':
        console.log('[FABRIC:PEER]', 'Peer sent IdentityRequest.  Responding with IdentityResponse (node id)...', self.id);
        response = Message.fromVector(['IdentityResponse', self.id]);
        break;
      case 'IdentityResponse':
        if (!self.peers[message.data]) {
          let peer = {
            id: message.data,
            address: packet.origin
          };

          // TODO: remove in favor of StartSession
          // Why?  Duplicate "peer" event is sent within _registerPeer
          // Try to register peer...
          /* try {
            self._registerPeer(peer);
          } catch (exception) {
            self.emit('error', `Could not register peer ${message.data} because: ${exception}`);
          } */
        }

        response = Message.fromVector(['StateRoot', JSON.stringify(self.state)]);
        break;
      case 'DocumentPublish':
        this.emit('log', `Document published from peer: ${message.data}`);
        this.emit('DocumentPublish', message.data);
        break;
      case 'DocumentRequest':
        this.emit('DocumentRequest', message.data);
        break;
      case 'BlockCandidate':
        break;
      case 'PeerCandidate':
        let candidate = null;

        try {
          candidate = JSON.parse(message.data);
        } catch (exception) {
          console.error('[FABRIC:PEER]', `[@ID:$${self.id}]`, 'Could not parse PeerCandidate message:', message.data, exception);
        }

        self.emit('peer:candidate', candidate);
        break;
      case 'PeerMessage':
        // console.error('[FABRIC:PEER]', `[@ID:$${self.id}]`, `Received "PeerMessage" from ${packet.origin} on socket:`, message.raw);
        // console.error('[FABRIC:PEER]', `[@ID:$${self.id}]`, `Packet origin:`, packet.origin);
        // TODO: use packet's peer ID, not socket address
        // Likely need to track connection?
        self.relayFrom(packet.origin, message);
        break;
      case 'StartSession':
        if (self.settings.verbosity >= 6) console.warn('[AUDIT]', '[FABRIC:PEER]', `[0x${self.id}]`, 'Received "StartSession" message on socket:', message.raw);
        let session = null;

        try {
          session = JSON.parse(message.data.toString('utf8'));
        } catch (exception) {
          console.error('[FABRIC:PEER]', 'Session body could not be parsed:', exception);
        }

        if (self.settings.verbosity >= 5) console.log('[FABRIC:PEER]', 'Proposed session:', session);

        // TODO: avoid using JSON in overall protocol
        // TODO: validate signature
        let valid = true;
        // TODO: restore session identity
        if (valid && session/* && session.identity */) {
          if (self.settings.verbosity >= 6) console.log('[AUDIT]', 'Session is valid...');

          let peer = {
            id: session.identity,
            address: packet.origin,
            advertise: `${self.pubkeyhash}@${self.public.ip}:${self.public.port}`,
            status: 'unfunded'
          };

          if (self.settings.verbosity >= 5) console.log('[FABRIC:PEER]', 'Peer to register:', peer);

          // TODO: document peer registration process
          self._registerPeer(peer);

          // TODO: use message type for next phase of session (i.e., NOISE)
          response = Message.fromVector(['StartSession', { identity: self.id }]);
          if (self.settings.verbosity >= 6) console.log('[AUDIT]', 'Will send response:', response);
        }

        break;
      case 'StateRoot':
        if (self.settings.verbosity >= 5) console.log('[AUDIT]', 'Message was a state root:', message.data);

        // TODO: test protocol flow (i.e., understand StateRoot)
        console.log('[AUDIT]', 'Message was a state root:', message.raw, message.data);

        try {
          const state = JSON.parse(message.data);
          self.emit('state', state);
          response = {
            'type': 'Receipt',
            'data': state
          };
        } catch (E) {
          console.error('[FABRIC:PEER]', 'Could not parse StateRoot:', E);
        }
        break;
      case 'StateChange':
        console.log('message was a state change:', message.data);
        break;
      case P2P_BASE_MESSAGE:
        self._handleBasePacket(packet);
        break;
      case P2P_ROOT:
        response = Message.fromVector([P2P_STATE_COMMITTMENT, self.state]);
        self.log('type was ROOT, sending state root:', response);
        self.log('type was ROOT, state was:', self.state);
        break;
      case P2P_INSTRUCTION:
        // TODO: use Fabric.Script / Fabric.Machine
        let stack = message.data.split(' ');
        switch (stack[1]) {
          case 'SIGN':
            let signature = self.key._sign(stack[0]);
            let buffer = Buffer.from(signature);
            let script = [buffer.toString('hex'), 'CHECKSIG'].join(' ');

            response = Message.fromVector([P2P_INSTRUCTION, script]);
            break;
          default:
            console.log('[PEER]', `unhandled peer instruction "${stack[1]}"`);
            break;
        }

        break;
      default:
        console.error('[PEER]', `unhandled message type "${message.type}"`);
        self.emit('error', `Unhandled message type "${message.type}"`);
        break;
    }

    // Emit for listeners
    // self.emit('message', message);

    if (relay) {
      self.relayFrom(origin, message);
    }

    return response;
  }

  _handleBasePacket (packet) {
    let message = null;

    try {
      message = JSON.parse(packet.message.data);
    } catch (E) {
      return this.log('Error parsing message:', E);
    }

    switch (message.type) {
      case 'collections:post':
        this.emit('collections:post', message.data);
        break;
      default:
        console.log('unhandled base packet type:', message.type);
        break;
    }
  }

  async sendToSocket (address, raw) {
    if (raw instanceof Message) {
      raw = raw.asRaw();
    }

    if (!this.connections[address]) {
      this.emit('error', `Could not deliver message to unconnected address: ${address}`);
      return false;
    }

    if (!this.connections[address].session) {
      this.emit('error', `Connection does not have a Session: ${address}`);
      return false;
    }

    if (!this.connections[address].writable) {
      this.emit('error', `Connection is not writable: ${address}`);
      return false;
    }

    this.emit('debug', `Writing ${raw.length} bytes to socket: \n\t${raw.toString('hex')}`);
    // const signature = await this.connections[address].session._appendMessage(raw);
    // self.emit('debug', `Signature: ${signature}`);

    try {
      const result = this.connections[address].write(raw);
      if (!result) {
        this.emit('warning', 'Stream result false.');
      }
    } catch (exception) {
      this.emit('error', `Exception writing to $[${address}]: ${exception}`);
    }
  }

  relayFrom (origin, message) {
    if (!origin) {
      this.emit('error', 'Must provide an origin.');
      return false;
    }

    if (!message) {
      this.emit('error', 'Must provide a message.');
      return false;
    }

    if (!(message instanceof Message)) {
      this.emit('error', 'Must provide a valid Fabric message.');
      return false;
    }

    this.emit('log', `Relaying ${message.type} from ${origin}: <${typeof message.data}> ${message.data}}`);

    let authorized = false;

    if (message.type) {
      switch (message.type) {
        case 'ChatMessage':
          authorized = true;
          break;
        case 'PeerCandidate':
          break;
        default:
          this.emit('debug', `Unhandled type: ${message.type}`);
          break;
      }
    } else {
      this.emit('warning', `Unknown message structure: <${message.constructor.name} ${JSON.stringify(message, null, '  ')} />`);
    }

    // For each known peer, send to the corresponding socket
    for (const id in this.peers) {
      this.emit('debug', `Is ${id} === ${origin}?`);
      if (id === origin) continue;
      const peer = this.peers[id];

      // TODO: select type byte for state updates
      // TODO: require `Message` type before broadcast (or, preferrably, cast as necessary)
      // let msg = Message.fromVector([P2P_BASE_MESSAGE, message]);
      const msg = Message.fromVector([
        message.type,
        message.data
      ]);

      const raw = msg.asRaw();
      this.emit('debug', `Preparing write (${raw.length} bytes): <${raw.constructor.name}> \n\t${raw.toString('hex')}`);

      if (authorized) {
        try {
          this.emit('debug', `Sending ${raw.length} bytes to address $[${peer.address}]: \n\t${raw.toString('hex')}`);
          this.sendToSocket(peer.address, raw);
        } catch (exception) {
          this.emit('error', `Could not write message to connection "${peer.address}":`, exception);
        }
      } else {
        this.emit('debug', 'Would have sent to socket:');
        this.emit('debug', `sendToSocket (${raw.length} bytes): from ${origin} to ${peer.address}: ${raw.toString('hex')})`);
      }
    }
  }

  broadcast (message) {
    // Coerce to Object
    if (message instanceof Message) {
      message = message.toObject();
    }

    if (typeof message !== 'string') message = JSON.stringify(message);
    let hash = crypto.createHash('sha256').update(message).digest('hex');

    // Do not relay duplicate messages
    if (this.messages.has(hash)) {
      if (this.settings.verbosity >= 3) console.warn('[FABRIC:PEER]', `Attempted to broadcast duplicate message ${hash} with content:`, message);
      return false;
    } else {
      this.memory[hash] = message;
      this.messages.add(hash);
    }

    for (let id in this.peers) {
      let peer = this.peers[id];
      // TODO: select type byte for state updates
      // TODO: require `Message` type before broadcast (or, preferrably, cast as necessary)
      // let msg = Message.fromVector([P2P_BASE_MESSAGE, message]);
      let msg = Message.fromVector(['PeerMessage', message]);

      try {
        this.sendToSocket(peer.address, msg);
      } catch (exception) {
        console.error('[FABRIC:PEER]', `Could not write message to connection "${peer.address}":`, exception);
      }
    }
  }

  _broadcastTypedMessage (type, message) {
    if (!message) message = '';
    if (typeof message !== 'string') message = JSON.stringify(message);

    let id = crypto.createHash('sha256').update(message).digest('hex');

    if (this.messages.has(id)) {
      this.log('attempted to broadcast duplicate message');
      return false;
    } else {
      this.memory[id] = message;
      this.messages.add(id);
    }

    for (let id in this.peers) {
      let peer = this.peers[id];
      // TODO: select type byte for state updates
      let msg = Message.fromVector([type, message]);
      this.sendToSocket(peer.address, msg);
    }
  }

  /**
   * Start listening for connections.
   * @fires Peer#ready
   * @return {Peer} Chainable method.
   */
  async listen () {
    const self = this;
    const promise = new Promise((resolve, reject) => {
      self.server.listen(self.port, self.address, function listenComplete (error) {
        if (error) return reject(error);

        const details = self.server.address();
        const address = `tcp://${details.address}:${details.port}`;

        self.emit('log', `Now listening on ${address} [!!!]`);
        return resolve(address);
      });
    });

    return promise;
  }
}

module.exports = Peer;
