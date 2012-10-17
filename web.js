var async   = require('async');
var express = require('express');
var util    = require('util');
var https   = require('https');
var fs      = require('fs');
var dynamicHelpers = require('./dynamicHelpers');

// create an express webserver
var app = express()
  , http = require('http');
http.createServer(app);

app.use(express.logger());
app.use(express.static(__dirname + '/public'));
app.use(express.bodyParser());
app.use(express.cookieParser());

// set this to a secret value to encrypt session cookies
app.use(express.session({ secret: process.env.SESSION_SECRET || 'secret123' }));
app.use(require('faceplate').middleware({
    app_id: process.env.FACEBOOK_APP_ID,
    secret: process.env.FACEBOOK_SECRET,
    scope:  'read_stream'
  })
);

var app_id = process.env.FACEBOOK_APP_ID;
var secret = process.env.FACEBOOK_SECRET;

// workaround for dynamichelpers in express 3
app.use(function(req, res, next){
  res.locals.url = dynamicHelpers.url(req, res)();
  res.locals.url_logo = dynamicHelpers.url(req, res)('/logo.png');
  res.locals.channel = dynamicHelpers.url_no_scheme(req, res)('/channel.html');
  next();
})

app.engine('xml', require('ejs').renderFile);

// set up mongodb
var mongo = require('mongodb'),
  Server = mongo.Server,
  Db = mongo.Db;

var server = new Server('localhost', 27017, {auto_reconnect: true});
var db = new Db('friendDb', server);

db.open(function(err, db) {
    if (!err) {
      console.log("Db connection established.");
    }
  });

// setup for facebook extended token storage/retrieval
db.createCollection('tokens', function(err, collection) {
  if (err) console.log(err);
});

// listen to the PORT given to us in the environment
var port = process.env.PORT || 3000;

app.listen(port, function() {
  console.log("Listening on " + port);
});


// server functions

function render_page(req, res) {
  req.facebook.app(function(app) {
    req.facebook.me(function(user) {
      res.render('index.ejs', {
        req:       req,
        app:       app,
        user:      user,
        app_id:    process.env.FACEBOOK_APP_ID
      });
    });
  });
}

// perform server-side graph api calls
function graph_get(path, token, cb) {
  https.get("https://graph.facebook.com/" + path + "?" + token, function(response) {
    var output = '';
    
    response.on("data", function(chunk) {
      output += chunk;
    });

    response.on('end', function() {
      var result = JSON.parse(output);
      cb(result.data ? result.data : result);
    });
  });
}

function handle_facebook_request(req, res) {

  // if the user is logged in
  if (req.facebook.token) {

    async.parallel([
      function(cb) {
        // check if token exists for current user
        req.facebook.me(function(user) {
          if (user != null && user.id != null) {
            db.collection('tokens', function(err, collection) {
              if (err) console.log(err);
              collection.findOne({username:user.username}, function(err, item) {
                // add token into db if one doesn't exist
                if (item == null) {
                  var options = {
                    host: 'graph.facebook.com',
                    path: '/oauth/access_token?client_id=' + app_id + 
                    '&client_secret=' + secret +
                    '&grant_type=fb_exchange_token&fb_exchange_token=' + req.facebook.token
                  };
                  https.get(options, function(response) {
                    response.on("data", function(chunk) {
                      fs.writeFileSync('log.txt', chunk, encoding='utf8', console.log);
                      var entry = {username:user.username, token:chunk.toString('utf8')};
                      collection.insert(entry, {safe: true}, console.log);
                    });
                  });
                }
              });
            });
          }
          cb();
        });
      },
      function(cb) {
        // query friend list
        req.facebook.get('/me/friends', {}, function(friends) {
          req.friends = JSON.stringify(friends);
          req.facebook.me(function(user) {
            
            // insert friend list into a collection corresponding to fb user id
            db.createCollection(user.id, {safe: true}, function(err, collection) {
              if (err) return;
              collection.insert(friends, {safe:true}, function(err, result) {
                if (err) throw err;
              });
            });

          });
          cb();
        });
      },
      function(cb) {
        // query 10 links and send them to the socket for this socket id
        req.facebook.get('/me/links', { limit: 6 }, function(links) {
          req.links = links;
          cb();
        });
      }
    ], function() {
      render_page(req, res);
    });

  } else {
    render_page(req, res);
  }
}

// handle json retrieval of friend list by autocomplete form
function retrieve_friends(req, res) {
  // if the user is logged in
  if (req.facebook.token) {
    var body = req.body;
    db.collection(body.uid, function(err, collection) {
      var reg = new RegExp("(^" + body.name_startsWith + ".*)|(.+ " + body.name_startsWith +")", "i");
      collection.find({"name": reg}).toArray(function(err, array) {
        res.send(JSON.stringify(array));
      });
    });
  } else {
    console.log("retrieve_friends: user not logged in");
  }
}

// retrieve the links corresponding to a given uid
function retrieve_links(req, res) {
  if (req.facebook.token) {
    req.facebook.get("/" + req.params.id, {}, function(user) {
      req.facebook.get("/" + req.params.id + "/links", {}, function(links) {
        res.set('Content-Type', 'text/xml');
        res.render('rss.ejs', {
          user:     user.name,
          links:    links
        });
      });
    });
 } else {
    // remote accessing of feed
    console.log("retrieve_links: user not logged in");
    db.collection('tokens', function(err, collection) {
      if (err) console.log(err);
      collection.findOne({username:req.params.user}, function(err, item) {
        if (item !== null) {
          var token = item["token"];
          graph_get("/" + req.params.id, token, function(user) {
            graph_get("/" + req.params.id + "/links", token, function(links) {
              res.render('rss.ejs', {
                user:     user.name,
                links:     links
              });
            });
          });
        }
      });
    });
 }
}

// handle logout
function logout(req, res) {
  db.dropCollection(req.body.uid, function() {});
}

app.get('/', handle_facebook_request);
app.post('/', handle_facebook_request);
app.post('/friendlist', retrieve_friends);
app.post('/logout', logout);
app.get('/:user', handle_facebook_request);
app.get('/:user/:id', retrieve_links);