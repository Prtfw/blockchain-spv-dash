'use strict';

var EventEmitter = require('events').EventEmitter;
var u = require('dash-util');
var DefaultBlock = require('bitcore-lib-dash').BlockHeader;
var inherits = require('inherits');
var reverse = require('buffer-reverse');
var struct = require('varstruct');
var varint = require('varuint-bitcoin');
var transaction = require('level-transactions');
require('setimmediate');

var storedBlock = struct([{ name: 'height', type: struct.UInt32LE }, { name: 'header', type: struct.VarBuffer(varint) }, { name: 'next', type: struct.Buffer(32) }]);

function encodeKey(hash) {
  if (Buffer.isBuffer(hash)) return hash.toString('base64');
  if (typeof hash === 'string') {
    if (hash.length !== 64) throw new Error('Invalid hash length');
    return reverse(new Buffer(hash, 'hex')).toString('base64');
  }
  throw new Error('Invalid hash');
}

var TX_TTL = 20 * 1000;

var BlockStore = module.exports = function (opts) {
  if (!opts.db) {
    throw new Error('Must specify "db" option');
  }
  this.db = opts.db;
  this.tx = null;
  this.txTimeout = null;
  this.committing = false;
  this.Block = opts.Block || DefaultBlock;
  this.indexInterval = opts.indexInterval;

  this.keyEncoding = 'utf8';
  this.valueEncoding = 'binary';
  this.dbOpts = {
    keyEncoding: this.keyEncoding,
    valueEncoding: this.valueEncoding
  };
};
inherits(BlockStore, EventEmitter);

BlockStore.prototype.commit = function (cb) {
  var _this = this;

  cb = cb || function (err) {
    if (err) _this.emit('error', err);
  };
  var tx = this.tx;
  this.tx = null;
  if (this.txTimeout) clearTimeout(this.txTimeout);
  if (tx) {
    this.committing = true;
    tx.commit(function (err) {
      _this.committing = false;
      _this.emit('commit');
      cb(err);
    });
  } else {
    cb(null);
  }
};

BlockStore.prototype.createTx = function (ttl) {
  if (this.tx) throw new Error('A db transaction already exists');
  var opts = { ttl: ttl ? ttl * 2 : null };
  this.tx = transaction(this.db, opts);
  if (ttl) {
    this.txTimeout = setTimeout(this.commit.bind(this), ttl);
    if (this.txTimeout.unref) this.txTimeout.unref();
  }
  return this.tx;
};

BlockStore.prototype.put = function (block, opts, cb) {
  var _this2 = this;

  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (this.isClosed()) return cb(new Error('Database is not open'));
  if (block.height == null) return cb(new Error('Must specify height'));
  if (block.header == null) return cb(new Error('Must specify header'));
  if (opts.tip) opts.best = true;
  if (opts.best) opts.link = true;
  if (opts.commit) {
    var _cb = cb;
    cb = function cb(err) {
      if (err) return _cb(err);
      _this2.commit(_cb);
    };
  }

  var tx = this.tx || this.createTx(TX_TTL);

  var blockEncoded = storedBlock.encode({
    height: block.height,
    header: block.header.toBuffer(),
    next: u.nullHash
  });
  var hash = block.header._getHash();
  tx.put(encodeKey(hash), blockEncoded, this.dbOpts);

  if (opts.link && opts.prev) {
    var prevEncoded = storedBlock.encode({
      height: opts.prev.height,
      header: opts.prev.header.toBuffer(),
      next: block.header._getHash()
    });
    tx.put(encodeKey(opts.prev.header._getHash()), prevEncoded, this.dbOpts);
  }

  var shouldIndex = block.height === 0 || opts.best;
  if (shouldIndex && block.height % this.indexInterval === 0) {
    tx.put(block.height.toString(), hash, this.dbOpts);
  }

  if (opts.tip) {
    this._setTip({ height: block.height, hash: block.header.getId() }, cb);
  } else {
    cb(null);
  }
};

BlockStore.prototype.get = function (hash, cb) {
  var _this3 = this;

  if (this.isClosed()) return cb(new Error('Database is not open'));
  if (this.committing) {
    this.once('commit', function () {
      return _this3.get(hash, cb);
    });
    return;
  }

  try {
    var key = encodeKey(hash);
  } catch (err) {
    return cb(err);
  }

  var db = this.tx || this.db;
  db.get(key, this.dbOpts, function (err, data) {
    if (err) return cb(err);
    setImmediate(function () {
      var block = storedBlock.decode(data);
      block.header = _this3.Block.fromBuffer(block.header);
      if (block.next.equals(u.nullHash)) block.next = null;
      cb(null, block);
    });
  });
};

BlockStore.prototype.getIndex = function (height, cb) {
  var _this4 = this;

  if (this.committing) {
    this.once('commit', function () {
      return _this4.getTip(cb);
    });
    return;
  }
  var interval = this.indexInterval;
  // we use floor instead of round because we might have not yet
  // synced to the larger height (ceil)
  var indexHeight = Math.floor(height / interval) * interval;
  var db = this.tx || this.db;
  db.get(indexHeight.toString(), this.dbOpts, cb);
};

BlockStore.prototype._setTip = function (tip, cb) {
  var newTip = {};
  for (var k in tip) {
    newTip[k] = tip[k];
  }delete newTip.header;
  this.tx.put('tip', newTip, {
    keyEncoding: 'utf8',
    valueEncoding: 'json'
  }, cb);
};

BlockStore.prototype.getTip = function (cb) {
  var _this5 = this;

  var self = this;
  if (this.committing) {
    this.once('commit', function () {
      return _this5.getTip(cb);
    });
    return;
  }
  var db = this.tx || this.db;
  db.get('tip', {
    keyEncoding: 'utf8',
    valueEncoding: 'json'
  }, function (err, tip) {
    if (err) return cb(err);
    self.get(tip.hash, function (err, block) {
      if (err) return cb(err);
      tip.hash = u.toHash(tip.hash);
      tip.header = block.header;
      cb(null, tip);
    });
  });
};

BlockStore.prototype.close = function (cb) {
  var _this6 = this;

  if (this.isClosed()) return cb(null);
  this.commit(function () {
    return _this6.db.close(cb);
  });
};

BlockStore.prototype.isClosed = function () {
  return this.db.isClosed();
};

BlockStore.prototype.isOpen = function () {
  return this.db.isOpen();
};