'use strict';

App.connectors['XMPP'] = function (account) {
  
  this.account = account;
  this.provider = Providers.data[account.core.provider];
  this.presence = {
    show: App.defaults.Connector.presence.show,
    status: App.defaults.Connector.presence.status
  };
  this.handlers = {};
  this.events = {}
  this.chat = {};
  
  this.connection = new Strophe.Connection(this.provider.connector.host);
  
  this.connect = function (callback) {
    var user = this.account.core.user;
    var pass = this.account.core.pass;
    var handler = function (status) {
     switch (status) {
        case Strophe.Status.CONNECTING:
          if (callback.connecting) {
            callback.connecting();
          }
          break;
        case Strophe.Status.CONNFAIL:
          if (callback.connfail) {
            callback.connfail();
          }
          break;
        case Strophe.Status.AUTHENTICATING:
          if (callback.authenticating) {
            callback.authenticating();
          }
          break;
        case Strophe.Status.AUTHFAIL:
          if (callback.authfail) {
            callback.authfail();
          }
          break;
        case Strophe.Status.CONNECTED:
          if (callback.connected) {
            callback.connected();
          }
          break;
        case Strophe.Status.DISCONNECTING:
          if (callback.disconnecting) {
            callback.disconnecting();
          }
          break;
        case Strophe.Status.DISCONNECTED:
          if (callback.disconnected) {
            callback.disconnected();
          }
          break;
      }
    }
    this.connection.connect(user, pass, handler, this.provider.connector.timeout);
  }
  
  this.disconnect = function () {
  
  }
  
  this.connected = function () {
    return App.online && this.connection && this.connection.connected;
  }
  
  this.start = function () {
    this.presence.set();
    this.handlers.init();
  }
  
  this.sync = function (callback) {
    var account = this.account;
    var connector = this;
    var realJid = Strophe.getBareJidFromJid(connector.connection.jid);
    if (account.core.realJid != realJid) {
      account.core.realJid = realJid;
      account.save();
    }
    var rosterCb = function (items, item, to) {
      if (to) {
        var sameOrigin = Strophe.getDomainFromJid(to) == Providers.data[account.core.provider].autodomain;
        var noMulti = !account.supports('multi');
        if (to == account.core.user || (noMulti && sameOrigin)) {
          connector.roster = items;
          connector.roster.sort(function (a,b) {
            var aname = a.name ? a.name : a.jid;
            var bname = b.name ? b.name : b.jid;
            return aname > bname;
          });
          var map = function (entry, cb) {
            var show, status;
            for (var j in entry.resources) {
              show = entry.resources[Object.keys(entry.resources)[0]].show || 'a';
              status = entry.resources[Object.keys(entry.resources)[0]].status || _('show' + show);
              break;
            }
            cb(null, {
              jid: entry.jid,
              name: entry.name,
              show: show,
              status: status
            });
          }
          async.map(connector.roster, map.bind(account), function (err, result) {
            account.core.roster = result;
            account.presenceRender();
          });
        }
      }
    }
    connector.connection.roster.registerCallback(rosterCb.bind(account));
    connector.connection.roster.get( function (ret) {
      rosterCb(ret, null, account.core.user);
      if (account.supports('vcard')) {
        connector.connection.vcard.get( function (data) {
          connector.vcard = $(data).find('vCard').get(0);
          callback();
        });
      } else {
        callback();
      }
    });
  }.bind(this);
  
  this.presence.set = function (show, status) {
    console.log(this);
    this.presence.show = show || this.presence.show;
    this.presence.status = status || this.presence.status;
    this.presence.send();
  }.bind(this);
  
  this.presence.send = function (show, status, priority) {
    console.log(this);
    var show = show || this.presence.show;
    var status = status || this.presence.status;
    var priority = priority || '127';
    if (App.online && this.connection.connected) {
      var msg = $pres();
      if (show != 'a') {
        msg.c('show', {}, show);
      }
      if (status) {
        msg.c('status', {}, status);
      }
      msg.c('priority', {}, priority);
      this.connection.send(msg.tree());
    }
    $('section#main').attr('data-show', show);
  }.bind(this);
  
  this.send = function (to, text, delay) {
    this.connection.Messaging.send(to, text, delay);
  }.bind(this);
  
  this.avatar = function (callback, jid) {
    var extract = function (vcard) {
      if (vcard.find('BINVAL').length) {
        var img = vcard.find('BINVAL').text();
        var type = vcard.find('TYPE').text();
        var avatar = 'data:' + type + ';base64,' + img;
        if (callback) {
          callback(avatar || 'img/foovatar.png');
        } 
      }
    }
    if (jid) {
      this.connection.vcard.get(function(data) {
        var vcard = $(data).find('vCard');
        extract(vcard);
      }, jid);
    } else {
      extract($(this.vcard));
    }
  }.bind(this);
  
  this.handlers.init = function () {
    if (!this.handlers.onMessage) {
      this.handlers.onMessage = this.connection.addHandler(this.events.onMessage, null, 'message', 'chat', null, null);
    }
    if (!this.handlers.onSubRequest) {
      this.handlers.onSubRequest = this.connection.addHandler(this.events.onSubRequest, null, 'presence', 'subscribe', null, null);
    }
    if (!this.handlers.onAttention) {
      this.attention = new AttentionPlugin(this.connection);
      this.handlers.onAttention = this.attention.setCallback(this.events.onAttention);
    }
  }.bind(this);
  
  this.events.onMessage = function (stanza) {
    var account = this.account;
    var tree = $(stanza);
    var from = Strophe.getBareJidFromJid(tree.attr('from'));
    var to = Strophe.getBareJidFromJid(tree.attr('to'));
    var body = tree.children("body").length ? tree.children("body").text() : null;
    var composing = tree.children("composing").length;
    var paused = tree.children("paused").length || tree.children("active").length;
    if (body) {
      var date = new Date();
      var stamp = tree.children('delay').length
        ? Tools.localize(tree.children('delay').attr('stamp'))
        : Tools.localize(Tools.stamp());
      var msg = new Message(account, {
        from: from,
        to: to,
        text: body,
        stamp: stamp
      });
      msg.receive();
    }
    if (account.supports('csn') && App.settings.csn) {
      if(composing && from == $('section#chat').data('jid')){
        $("section#chat #typing").show();
      }else if(paused && from == $('section#chat').data('jid')){
        $("section#chat #typing").hide();
      }
    }
    return true;
  }.bind(this);
  
  this.events.onSubRequest = function (stanza) {
    this.connection.roster.authorize(Strophe.getBareJidFromJid($(stanza).attr('from')));
    return true;
  }.bind(this);
  
  this.events.onAttention = function (stanza) {
    if (App.settings.boltGet) {
      var from = Strophe.getBareJidFromJid($(stanza).attr('from'));
      var chat = this.account.chats[this.account.chatFind(from)];
      if (!chat) {
        var contact = Lungo.Core.findByProperty(this.account.core.roster, 'jid', this.account.core.jid);
        chat = new Chat({
          jid: from,
          title: contact ? contact.name || from : from,
          chunks: []
        }, connector.account);
      }
      window.navigator.vibrate([100,30,100,30,100,200,200,30,200,30,200,200,100,30,100,30,100]);
      App.notify({
        subject: chat.core.title,
        text: _('HasSentYouABolt'),
        pic: 'img/bolt.png',
        callback: function () {
          chat.show();
          App.toForeground();
        }
      }, 'thunder');
    }
    console.log(from, 'sent you a bolt.');
    return true;
  }.bind(this);
  
}
