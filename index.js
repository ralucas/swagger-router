"use strict";

// For Map. Not used in the fast path.
require("es6-shim");


/***
 * :SECTION 1:
 * Private module variables and methods
 ***/

// a global variable holding the ID the next created node should have
var nextNodeId = 0;

function normalizePath (path) {
    if (path.split) {
        path = path.replace(/^\//, '').split(/\//);
    } else if(!(Array.isArray(path))) {
        throw new Error("Invalid path: " + path);
    }
    // Re-join {/var} patterns
    for (var i = 0; i < path.length - 1; i++) {
        if (/{$/.test(path[i]) && /}$/.test(path[i+1])) {
            var rest = path[i].replace(/{$/, '');
            if (rest.length) {
                path.splice(i, 2, rest, '{/' + path[i+1]);
            } else {
                path.splice(i, 2, '{/' + path[i+1]);
            }
        }
    }
    return path;
}

function parsePattern (pattern) {
    var bits = normalizePath(pattern);
    // Parse pattern segments and convert them to objects to be consumed by
    // Node.set().
    return bits.map(function(bit) {
        // Support named but fixed values as
        // {domain:en.wikipedia.org}
        var m = /^{([+\/])?([a-zA-Z0-9_]+)(?::([^}]+))?}$/.exec(bit);
        if (m) {
            if (m[1]) {
                throw new Error("Modifiers are not yet implemented!");
            }
            return {
                modifier: m[1],
                name: m[2],
                pattern: m[3]
            };
        } else {
            return bit;
        }
    });
}


/***
 * :SECTION 2:
 * Module class definitions
 ***/

/*
 * A node in the lookup graph.
 *
 * We use a single monomorphic type for the JIT's benefit.
 */
function Node () {
    // The value for a path ending on this node. Public property.
    this.value = null;
    // this node's ID
    this.id = nextNodeId++;

    // Internal properties.
    this._map = {};
    this._name = null;
    this._wildcard = null;
}

Node.prototype.set = function(key, value) {
    if (key.constructor === String) {
        this._map['k' + key] = value;
    } else if (key.name && key.pattern && key.pattern.constructor === String) {
        // A named but plain key. Check if the name matches & set it normally.
        if (this._name && this._name !== key.name) {
            throw new Error("Captured pattern parameter " + key.name
                    + " does not match existing name " + this._name);
        }
        this._name = key.name;
        this._map['k' + key.pattern] = value;
    } else {
        // Setting up a wildcard match
        // Check if there are already other non-empty keys
        var longKeys = Object.keys(this._map).filter(function(key) {
            return key.length > 1;
        });
        if (longKeys.length) {
            throw new Error("Can't register \"" + key + "\" in a wildcard path segment!");
        } else {
            this._name = key.name;
            // Could handle a modifier or regexp here as well
            this._wildcard = value;
        }
    }
};

Node.prototype.get = function(segment, params) {
    if (segment.constructor === String) {
        // Fast path
        if (segment !== '') {
            var res = this._map['k' + segment] || this._wildcard;
            if (this._name && res) {
                params[this._name] = segment;
            }
            return res;
        } else {
            // Don't match the wildcard with an empty segment.
            return this._map['k' + segment];
        }

    // Fall-back cases for internal use during tree construction. These cases
    // are never used for actual routing.
    } else if (segment.pattern) {
        // Unwrap the pattern
        return this.get(segment.pattern, params);
    } else if (segment.name === this._name) {
        // XXX: also compare modifier!
        return this._wildcard;
    }
};

Node.prototype.hasChildren = function () {
    return Object.keys(this._map).length || this._wildcard;
};

Node.prototype.keys = function () {
    var self = this;
    if (this._wildcard) {
        return [];
    } else {
        var res = [];
        Object.keys(this._map).forEach(function(key) {
            // Only list '' if there are children (for paths like
            // /double//slash)
            if (key !== 'k' || self._map[key].hasChildren()) {
                res.push(key.replace(/^k/, ''));
            }
        });
        return res.sort();
    }
};


/**
 * Represents a URI object which can optionally contain and
 * bind optional variables encountered in the URI string
 *
 * @param {String|URI} uri the URI path or object to create a new URI from
 * @param {Object} params the values for variables encountered in the URI path (optional)
 */
function URI(uri, params) {
    if (uri.constructor === URI) {
        this._uri = [];
        uri._uri.forEach(function (item) {
            if (item.constructor === Object) {
                this._uri.push({
                    modifier: item.modifier,
                    name: item.name,
                    pattern: item.pattern
                });
            } else {
                this._uri.push(item);
            }
        }, this);
    } else if (uri.constructor === String || uri.constructor === Array) {
        this._uri = parsePattern(uri);
    }
    this._str = null;
    if (params) {
        this.bind(params);
    }
}

/**
 * Binds the provided parameter values to URI's variable components
 *
 * @param {Object} params the parameters (and their values) to bind
 * @return {URI} this URI object
 */
URI.prototype.bind = function (params) {
    if (!params || params.constructor !== Object) {
        // wrong params format
        return this;
    }
    // look only for parameter keys which match
    // variables in the URI
    this._uri.forEach(function (item) {
        if(item && item.constructor === Object && params[item.name]) {
            item.pattern = params[item.name];
            // we have changed a value, so invalidate the string cache
            this._str = null;
        }
    }, this);
    return this;
};

/**
 * Builds and returns the full, bounded string path for this URI object
 *
 * @return {String} the complete path of this URI object
 */
URI.prototype.toString = function () {
    if (this._str) {
        // there is a cached version of the URI's string
        return this._str;
    }
    this._str = '';
    this._uri.forEach(function (item) {
        if (item.constructor === Object) {
            if (item.pattern) {
                // there is a known value for this variable,
                // so use it
                this._str += '/' + encodeURIComponent(item.pattern);
            } else if (item.modifer) {
                // we are dealing with a modifier, and there
                // seems to be no value, so simply ignore the
                // component
                this._str += '';
            } else {
                // we have a variable component, but no value,
                // so let's just return the variable name
                this._str += '/{' + item.name + '}';
            }
        } else {
            this._str += '/' + item;
        }
    }, this);
    return this._str;
};


/*
 * The main router object
 */
function Router () {
    this._root = new Node();
    // Map for sharing of sub-trees corresponding to the same specs, using
    // object identity on the spec fragment. Not yet implemented.
    this._nodes = new Map();
}

Router.prototype._buildTree = function(segments, value) {
    var node = new Node();
    if (segments.length) {
        var segment = segments[0];
        var subTree = this._buildTree(segments.slice(1), value);
        node.set(segment, subTree);
    } else {
        node.value = value;
    }
    return node;
};

Router.prototype.addSpec = function addSpec(spec, prefix) {
    var spec_root, instance_root, params = {};
    if (!spec || !spec.paths) {
        throw new Error("No spec or no paths defined in spec!");
    }
    // Get the prefix
    prefix = parsePattern(prefix || []);
    // do we know this spec already ?
    if (!this._nodes.has(spec)) {
        // this is a new spec, so we need to build its tree
        spec_root = new Node();
        for (var path in spec.paths) {
            var segments = parsePattern(path);
            this._extend(segments, spec_root, spec.paths[path]);
        }
        // add it to the spec map
        this._nodes.set(spec, spec_root);
    }
    // create the prefix nodes and connect them to the spec sub-tree
    spec_root = this._nodes.get(spec);
    this._extend(prefix, this._root, null);
    instance_root = this._root;
    for (var idx = 0; idx < prefix.length; idx++) {
        instance_root = instance_root.get(prefix[idx], params);
    }
    instance_root._wildcard = spec_root._wildcard;
    for (var key in spec_root._map) {
        instance_root._map[key] = spec_root._map[key];
    }
};

Router.prototype.delSpec = function delSpec(spec, prefix) {
    // Possible implementation:
    // - Perform a *recursive* lookup for each leaf node.
    // - Walk up the tree and remove nodes as long as `.hasChildren()` is
    //   false.
    // This will work okay in a tree, but would clash with subtree sharing in
    // a graph. We should perform some benchmarks to see if subtree sharing is
    // worth it. Until then we probably don't need spec deletion anyway, as we
    // can always re-build the entire router from scratch.
    throw new Error("Not implemented");
};

// Extend an existing route tree with a new path by walking the existing tree
// and inserting new subtrees at the desired location.
Router.prototype._extend = function route(path, node, value) {
    var params = {};
    var origNode = node;
    for (var i = 0; i < path.length; i++) {
        var nextNode = node.get(path[i], params);
        if (!nextNode || !nextNode.get) {
            // Found our extension point
            node.set(path[i], this._buildTree(path.slice(i+1), value));
            return;
        } else {
            node = nextNode;
        }
    }
    node.value = value;
};

// Lookup worker.
Router.prototype._lookup = function route(path, node) {
    var params = {};
    var prevNode;
    for (var i = 0; i < path.length; i++) {
        if (!node || !node.get) {
            return null;
        }
        prevNode = node;
        node = node.get(path[i], params);
    }
    if (node && node.value) {
        if (path[path.length - 1] === '') {
            // Pass in a listing
            params._ls = prevNode.keys();
        }
        return {
            params: params,
            value: node.value
        };
    } else {
        return null;
    }
};

/*
 * Look up a path in the router, and return either null or the configured
 * object.
 *
 * @param {string|array} path
 * @return {null|object} with object being
 *  {
 *    params: {
 *      someParam: 'pathcomponent'
 *    },
 *    value: theValue
 *  }
 */
Router.prototype.lookup = function route(path) {
    path = normalizePath(path);
    return this._lookup(path, this._root);
};

/**
 * Reports the number of nodes created by the router. Note that
 * this is the total number of created nodes; if some are deleted,
 * this number is not decreased.
 *
 * @return {Number} the total number of created nodes
 */
Router.prototype.noNodes = function () {
    return nextNodeId;
};

module.exports = {
    Router: Router,
    URI: URI,
    Node: Node
};
