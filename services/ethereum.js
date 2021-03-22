'use strict';

const BN = require('bn.js');
const jayson = require('jayson');

const Entity = require('../types/entity');
const Service = require('../types/service');
const Transition = require('../types/transition');

// Ethereum
const VM = require('ethereumjs-vm').default;
const Account = require('ethereumjs-account').default;
const Blockchain = require('ethereumjs-blockchain').default;
const Block = require('ethereumjs-block');
const Opcodes = {
  STOP: '00',
  ADD: '01',
  PUSH1: '60'
};

class Ethereum extends Service {
  constructor (settings = {}) {
    super(settings);

    this.status = 'constructing';
    this.settings = Object.assign({
      name: '@services/ethereum',
      mode: 'rpc',
      ETHID: 1,
      hosts: [],
      stack: []
    }, settings);

    this._state = {
      stack: this.settings.stack
    };

    this.rpc = null;
    this.vm = new VM();
    this.status = 'constructed';
  }

  async _test () {
    let program = [
      Opcodes.PUSH1,
      '03',
      Opcodes.PUSH1,
      '05',
      Opcodes.ADD, 
      Opcodes.STOP
    ];

    return this.execute(program);
  }

  async _handleVMStep (step) {
    console.log('[SERVICES:ETHEREUM]', '[VM]', `Executed Opcode: ${step.opcode.name}\n\tStack:`, step.stack);
    let transition = Transition.between(this._state.stack, step.stack);
    this._state.stack = step.stack;
    console.log('transition:', transition);``
  }

  async execute (program) {
    if (!(program instanceof Array)) throw new Error('Cannot process program unless it is an Array.');

    return this.vm.runCode({
      code: Buffer.from(program.join(''), 'hex'),
      gasLimit: new BN(0xffff),
    }).then(results => {
      console.log('Returned : ' + results.returnValue.toString('hex'));
      console.log('Gas used : ' + results.gasUsed.toString());
    }).catch(err => console.log('Error    : ' + err));
  }

  async _checkRPCBlockNumber () {
    const service = this;
    service.rpc.request('eth_blockNumber', [], function(err, response) {
      if (err) service.emit('error', `Could not call: ${err}`);
      service.emit('warning', `Current block: ${response.result}`);
    });
  }

  async stop () {
    this.status = 'stopping';
    // await this.vm.destroy();

    if (this.settings.mode === 'rpc') {
      clearInterval(this.heartbeat);
    }

    this.status = 'stopped';
  }

  async start () {
    const service = this;
    service.status = 'starting';

    if (service.settings.mode === 'rpc') {
      // create a client
      service.rpc = jayson.client.https({
        host: 'typhoon.nakamoto.group',
        port: 443
      });

      // await service._checkRPCBlockNumber();
      service.heartbeat = setInterval(function _checkRPCBlockNumber () {
        service.rpc.request('eth_blockNumber', [], function(err, response) {
          if (err) service.emit('error', `Could not call: ${err}`);
          service.emit('warning', `Current block: ${response.result}`);
        });
      }, 5000);
    }

    service.vm.on('step', service._handleVMStep.bind(service));
    service.status = 'started';
    service.emit('warning', `Service started!`);
  }

  async _RPCErrorHandler (error) {
    this.emit('error', `[RPC] Error: ${error}`);
  }
}

module.exports = Ethereum;
