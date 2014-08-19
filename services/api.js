var _ = require('underscore');
var logger = require('./loggingservice.js');
var Bitstamp = require('bitstamp');
var Kraken = require('kraken-api');
var async = require('async');

//------------------------------Config
var config = require('../config.js');
//------------------------------Config

var api = function() {

  this.exchange = config.exchangeSettings.exchange;
  this.currencyPair = config.exchangeSettings.currencyPair;

  if(this.exchange === 'bitstamp') {

    var key = config.apiSettings.bitstamp.apiKey;
    var secret = config.apiSettings.bitstamp.secret;
    var client_id = config.apiSettings.bitstamp.clientId;

    this.bitstamp = new Bitstamp(key, secret, client_id);

  } else if(this.exchange === 'kraken') {

    this.kraken = new Kraken(config.apiSettings.kraken.apiKey, config.apiSettings.kraken.secret);

  } else {

    logger.error('Invalid exchange, exiting!');
    return process.exit();

  }

  this.q = async.queue(function (task, callback) {
    task();
    setTimeout(callback,1000);
  }, 1);

  _.bindAll(this, 'retry', 'errorHandler', 'getTrades', 'getBalance', 'getOrderBook', 'placeOrder', 'orderFilled' ,'cancelOrder');

};

api.prototype.retry = function(method, args) {

  var self = this;

  // make sure the callback (and any other fn)
  // is bound to api
  _.each(args, function(arg, i) {
    if(_.isFunction(arg))
      args[i] = _.bind(arg, self);
  });

  // run the failed method again with the same
  // arguments after wait
  setTimeout(function() { method.apply(self, args); }, 1000*15);

};

api.prototype.errorHandler = function(method, receivedArgs, retryAllowed, caller, cb) {

  var args = _.toArray(receivedArgs);

  return function(err, result) {

    if(err) {

      var parsedError;

      if(JSON.stringify(err) === '{}' && err.message) {
        parsedError = err.message;
      } else {
        parsedError = JSON.stringify(err);
      }

      if(this.exchange === 'kraken' && parsedError === '["EQuery:Unknown asset pair"]') {

        logger.error('Kraken returned Unknown asset pair error, exiting!');
        return process.exit();

      } else if(retryAllowed) {

        logger.error(caller + ' Couldn\'t connect to the API, retrying in 15 seconds!');
        logger.error(parsedError.substring(0,99));
        return this.retry(method, args);

      } else {

        logger.error(caller + ' Couldn\'t connect to the API.');
        cb(parsedError, null);
        return logger.error(parsedError.substring(0,99));

      }

    }

    if(this.exchange === 'bitstamp' && result.error === 'Invalid nonce') {
      logger.error('Bitstamp returned invalid nonce error, retrying in 15 seconds!');
      return this.retry(method, args);
    }

    logger.debug('API Call Result (Substring)!');
    logger.debug(JSON.stringify(result).substring(0,99));

    //_.last(args)(null, result);
    cb(null, result);

  }.bind(this);

};

api.prototype.getTrades = function(retry, cb) {

  var args = arguments;

  var wrapper = function() {

    var handler;

    var pair = this.currencyPair.pair;

    if(this.exchange === 'bitstamp') {

      handler = function(err, response) {

        if(!err) {

          var trades = _.map(response, function(t) {

            return {date: parseInt(t.date), price: parseFloat(t.price), amount: parseFloat(t.amount)};

          });

          var result = _.sortBy(trades, function(trade){ return trade.date; });

          cb(null, result);

        } else {

          cb(err, null);

        }

      };

      this.bitstamp.transactions({time: 'hour'}, this.errorHandler(this.getTrades, args, retry, 'getTrades', handler));

    } else if(this.exchange === 'kraken') {

      handler = function(err, data) {

        if(!err) {

          var values = _.find(data.result, function(value, key) {

            return key === pair;

          });

          var trades = _.map(values, function(t) {

            return {date: parseInt(t[2]), price: parseFloat(t[0]), amount: parseFloat(t[1])};

          });

          cb(null, trades);

        } else {

          cb(err, null);

        }

      };

      this.kraken.api('Trades', {"pair": pair}, this.errorHandler(this.getTrades, args, retry, 'getTrades', handler));

    }

  };

  this.q.push(_.bind(wrapper,this));

};

api.prototype.getBalance = function(retry, cb) {

  var args = arguments;

  var wrapper = function() {

    var handler;

    var asset = this.currencyPair.asset;
    var currency = this.currencyPair.currency;

    var pair = this.currencyPair.pair;

    if(this.exchange === 'bitstamp') {

      handler = function(err, result) {

        if(!err) {

          cb(null, {currencyAvailable:result.usd_available, assetAvailable:result.btc_available, fee:result.fee});

        } else {

          cb(err, null);

        }

      };

      this.bitstamp.balance(this.errorHandler(this.getBalance, args, retry, 'getBalance', handler));

    } else if(this.exchange === 'kraken') {

      handler = function(err, data) {

        if(!err) {

          var assetValue = _.find(data.result, function(value, key) {
            return key === asset;
          });

          var currencyValue = _.find(data.result, function(value, key) {
            return key === currency;
          });

          if(!assetValue) {
            assetValue = 0;
          }

          if(!currencyValue) {
            currencyValue = 0;
          }

          this.kraken.api('TradeVolume', {"pair": pair}, this.errorHandler(this.getBalance, args, retry, 'getBalance', function(err, data) {

            if(!err) {

              var fee = parseFloat(_.find(data.result.fees, function(value, key) {
                return key === pair;
              }).fee);

              cb(null, {currencyAvailable:currencyValue, assetAvailable:assetValue, fee:fee});

            } else {

              cb(err, null);

            }

          }));

        } else {

          cb(err, null);

        }

      }.bind(this);

      this.kraken.api('Balance', {}, this.errorHandler(this.getBalance, args, retry, 'getBalance', handler));

    }

  };

  this.q.push(_.bind(wrapper,this));

};

api.prototype.getOrderBook = function(retry, cb) {

  var args = arguments;

  var wrapper = function () {

    var handler;

    var pair = this.currencyPair.pair;

    if(this.exchange === 'bitstamp') {

      handler = function(err, result) {

        if(!err) {

          var bids = _.map(result.bids, function(bid) {
            return {assetAmount: bid[1], currencyPrice: bid[0]};
          });

          var asks = _.map(result.asks, function(ask) {
            return {assetAmount: ask[1], currencyPrice: ask[0]};
          });

          cb(null, {bids: bids, asks: asks});

        } else {

          cb(err, null);

        }

      };

      this.bitstamp.order_book(1, this.errorHandler(this.getOrderBook, args, retry, 'getOrderBook', handler));

    } else if(this.exchange === 'kraken') {

      handler = function(err, data) {

        if(!err) {

          var orderbook = _.find(data.result, function(value, key) {

            return key === pair;

          });

          var bids = _.map(orderbook.bids, function(bid) {
            return {assetAmount: bid[1], currencyPrice: bid[0]};
          });

          var asks = _.map(orderbook.asks, function(ask) {
            return {assetAmount: ask[1], currencyPrice: ask[0]};
          });

          cb(null, {bids: bids, asks: asks});

        } else {

          cb(err, null);

        }

      };

      this.kraken.api('Depth', {"pair": pair}, this.errorHandler(this.getOrderBook, args, retry, 'getOrderBook', handler));

    }

  };

  this.q.push(_.bind(wrapper,this));

};

api.prototype.placeOrder = function(type, amount, price, retry, cb) {

  var args = arguments;

  var wrapper = function() {

    var handler;

    var pair = this.currencyPair.pair;

    if(this.exchange === 'bitstamp') {

      handler = function(err, result) {

        if(!err) {

          cb(null, {txid: result.id});

        } else {

          cb(err, null);

        }

      };

      if(type === 'buy') {

        this.bitstamp.buy(amount, price, this.errorHandler(this.placeOrder, args, retry, 'placeOrder', handler));

      } else if (type === 'sell') {

        this.bitstamp.sell(amount, price, this.errorHandler(this.placeOrder, args, retry, 'placeOrder', handler));

      } else {

        logger.log('Invalid order type!');
      }

    } else if(this.exchange === 'kraken') {

      handler = function(err, data) {

        if(!err) {

          cb(null, {txid: data.result.txid[0]});

        } else {

          cb(err, null);

        }

      };

      if(type === 'buy') {

        this.kraken.api('AddOrder', {"pair": pair, "type": 'buy', "ordertype": 'limit', "price": price, "volume": amount}, this.errorHandler(this.placeOrder, args, retry, 'placeOrder', handler));

      } else if (type === 'sell') {

        this.kraken.api('AddOrder', {"pair": pair, "type": 'sell', "ordertype": 'limit', "price": price, "volume": amount}, this.errorHandler(this.placeOrder, args, retry, 'placeOrder', handler));

      } else {

        logger.log('Invalid order type!');

      }

    }

  };

  this.q.push(_.bind(wrapper,this));

};

api.prototype.orderFilled = function(order, retry, cb) {

  var args = arguments;

  var wrapper = function() {

    var handler;

    if(this.exchange === 'bitstamp') {

      handler = function(err, result) {

        if(!err) {

          var open = _.find(result, function(o) {

            return o.id === order;

          }, this);

          if(open) {

            cb(null, false);

          } else {

            cb(null, true);

          }

        } else {

          cb(err, null);

        }

      };

      this.bitstamp.open_orders(this.errorHandler(this.orderFilled, args, retry, 'orderFilled', handler));

    } else if(this.exchange === 'kraken') {

      handler = function(err, data) {

        if(!err) {

          var open = _.find(data.result.open, function(value, key) {

            return key === order;

          });

          if(open) {

            cb(null, false);

          } else {

            cb(null, true);

          }

        } else {

          cb(err, null);

        }

      };

      this.kraken.api('OpenOrders', {}, this.errorHandler(this.orderFilled, args, retry, 'orderFilled', handler));

    }

  };

  this.q.push(_.bind(wrapper,this));

};

api.prototype.cancelOrder = function(order, retry, cb) {

  var args = arguments;

  var wrapper = function() {

    var handler;

    if(this.exchange === 'bitstamp') {

      handler = function(err, result) {

        if(!err) {

          if(!result.error) {
            cb(null, true);
          } else {
            cb(null, false);
          }

        } else {

          cb(err, null);

        }

      };

      this.bitstamp.cancel_order(order,this.errorHandler(this.cancelOrder, args, retry, 'cancelOrder', handler));

    } else if(this.exchange === 'kraken') {

      this.orderFilled(order, true, function(err, filled) {

        if(!filled) {

          handler = function(err, data) {

            if(!err) {

              if(data.result.count > 0) {
                cb(null, true);
              } else {
                cb(null, false);
              }

            } else {

              cb(err, null);

            }

          };

          this.kraken.api('CancelOrder', {"txid": order}, this.errorHandler(this.cancelOrder, args, retry, 'cancelOrder', handler));

        } else {

          cb(null, false);

        }

      }.bind(this));

    }

  };

  this.q.push(_.bind(wrapper,this));

};

var apiservice = new api();

module.exports = apiservice;
