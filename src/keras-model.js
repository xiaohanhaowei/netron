/*jshint esversion: 6 */

class KerasModelFactory {

    match(context, host) {
        var extension = context.identifier.split('.').pop();
        if (extension == 'keras' || extension == 'h5' || extension == 'hdf5') {
            return true;
        }
        if (extension == 'json' && !context.identifier.endsWith('-symbol.json')) {
            var json = context.text;
            if (json.indexOf('\"mxnet_version\":', 0) == -1) {
                try {
                    var model_config = JSON.parse(json);
                    if (model_config && model_config.modelTopology && model_config.modelTopology.model_config) {
                        model_config = model_config.modelTopology.model_config;
                    }
                    if (model_config && model_config.class_name) {
                        return true;
                    }
                }
                catch (err) {
                }
            }
        }
        return false;
    }

    open(context, host, callback) {
        host.require('hdf5', (err) => {
            if (err) {
                callback(err, null);
                return;
            }
            var format = 'Keras';
            var model_config = null;
            var rootGroup = null;
            var rootJson = null;
            try {
                var extension = context.identifier.split('.').pop();
                if (extension == 'keras' || extension == 'h5' || extension == 'hdf5') {
                    var file = new hdf5.File(context.buffer);
                    rootGroup = file.rootGroup;
                    if (!rootGroup.attributes.model_config) {
                        callback(new KerasError('HDF5 file does not contain a Keras \'model_config\' graph. Use \'save()\' instead of \'save_weights()\' to save both the graph and weights.'), null);
                        return;
                    }
                    model_config = JSON.parse(rootGroup.attributes.model_config);
                }
                else if (extension == 'json') {
                    var json = context.text;
                    model_config = JSON.parse(json);
                    if (model_config && model_config.modelTopology && model_config.modelTopology.model_config) {
                        format = 'TensorFlow.js ' + format;
                        rootJson = model_config;
                        model_config = model_config.modelTopology.model_config;
                    }
                }
            }
            catch (error) {
                host.exception(error, false);
                callback(new KerasError(error.message), null);
                return;
            }

            if (!model_config) {
                callback(new KerasError('\'model_config\' is not present.'));
                return;
            }
            if (!model_config.class_name) {
                callback(new KerasError('\'class_name\' is not present.'), null);
                return;
            }

            KerasOperatorMetadata.open(host, (err, metadata) => {
                try {
                    var model = new KerasModel(format, model_config, rootGroup, rootJson);
                    callback(null, model);
                }
                catch (error) {
                    host.exception(error, false);
                    callback(new KerasError(error.message), null);
                }
            });
        });
    }
}

class KerasModel {

    constructor(format, model_config, rootGroup, rootJson) {
        this._format = format;
        this._graphs = [];

        var model_weights = null;
        var weightsManifest = null;
        if (rootGroup) {
            if (rootGroup.attributes.keras_version) {
                this._version = rootGroup.attributes.keras_version;
            }
            if (rootGroup.attributes.backend) {
                this._backend = rootGroup.attributes.backend;
            }
            model_weights = rootGroup.group('model_weights');
        }
        else if (rootJson) {
            if (rootJson.modelTopology && rootJson.modelTopology.keras_version) {
                this._version = rootJson.modelTopology.keras_version;
            }
            if (rootJson.modelTopology && rootJson.modelTopology.backend) {
                this._backend = rootJson.modelTopology.backend;
            }
            if (rootJson.weightsManifest) {
                weightsManifest = {};
                rootJson.weightsManifest.forEach((manifest) => {
                    var match = false;
                    var key = null;
                    manifest.weights.forEach((weights) => {
                        var name = weights.name.split('/').shift();
                        if (key == null) {
                            key = name;
                            match = true;
                        }
                        else if (key != name) {
                            match = false;
                        }
                    });
                    if (match) {
                        weightsManifest[key] = manifest;
                    }
                });
            }
        }

        this._activeGraph = new KerasGraph(model_config, model_weights, weightsManifest);
        this._graphs.push(this._activeGraph);
    }

    get name() {
        return null;
    }

    get description() {
        return null;
    }

    get format() {
        return this._format + (this._version ? (' v' + this._version) : '');
    }

    get runtime() {
        return this._backend;
    }

    get graphs() {
        return this._graphs;
    }
}

class KerasGraph {

    constructor(model, model_weights, weightsManifest) {
        if (model.name) {
            this._name = model.name;
        }
        else if (model.config && model.config.name) {
            this._name = model.config.name;
        }
        this._inputs = [];
        this._outputs = [];
        this._nodes = [];
        this._groups = false;
        this._operators = {};

        switch (model.class_name) {
            case 'Sequential':
                this._loadSequential(model.config, model_weights, weightsManifest, '', null, null);
                break;
            case 'Model':
                this._loadModel(model.config, model_weights, weightsManifest, '', null, null);
                break;
            default:
                throw new KerasError('\'' + model.class_name + '\' is not supported.');
        }
    }

    get operators() {
        return this._operators;
    }

    get name() {
        return this._name;
    }

    get groups() {
        return this._groups ? true : false;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }

    _loadModel(config, model_weights, weightsManifest, group, inputs, outputs) {
        if (group) {
            this._groups = true;
        }
        if (config.layers) {
            var nodeMap = {};
            config.layers.forEach((layer) => {
                if (layer.name) {
                    if (!nodeMap[layer.name]) {
                        nodeMap[layer.name] = layer;
                        layer._inputs = [];
                        layer._outputs = [];
                    }
                }
            });
            config.layers.forEach((layer) => {
                if (layer.inbound_nodes) {
                    layer.inbound_nodes.forEach((inbound_node) => {
                        inbound_node.forEach((inbound_connection) => {
                            var inputName = inbound_connection[0];
                            var inputNode = nodeMap[inputName];
                            if (inputNode) {
                                var inputIndex = inbound_connection[2];
                                if (inputIndex != 0) {
                                    inputName += ':' + inputIndex.toString();
                                }
                                while (inputIndex >= inputNode._outputs.length) {
                                    inputNode._outputs.push('');        
                                }     
                                inputNode._outputs[inputIndex] = inputName;
                            }
                            layer._inputs.push(inputName);
                        });       
                    });
                }
            });
        }
        if (config.input_layers) {
            config.input_layers.forEach((input_layer, index) => {
                var name = input_layer[0];
                var type = null;
                var node = nodeMap[name];
                if (node && node.class_name == 'InputLayer') {
                    type = this._getInputType(node);
                    delete nodeMap[name];
                }
                if (inputs && index < inputs.length) {
                    if (config.layers) {
                        config.layers.forEach((layer) => {
                            if (layer._inputs) {
                                layer._inputs = layer._inputs.map((input) => {
                                    if (input == name) {
                                        return inputs[index];
                                    }
                                    return input;
                                });
                            }
                        });
                    }            
                }
                else {
                    this._inputs.push(new KerasArgument(name, true, [ new KerasConnection(name, type, null) ])); 
                }
            });
        }
        if (config.output_layers) {
            config.output_layers.forEach((output_layer, index) => {
                var inputName = output_layer[0];
                var inputNode = nodeMap[inputName];
                var addGraphOutput = true;
                if (outputs && index < outputs.length) {
                    inputName = outputs[index];
                    addGraphOutput = false;
                }
                if (inputNode) {
                    var inputIndex = output_layer[2];
                    if (inputIndex != 0) {
                        inputName += ':' + inputIndex.toString();
                    }
                    while (inputIndex >= inputNode._outputs.length) {
                        inputNode._outputs.push('');
                    }
                    inputNode._outputs[inputIndex] = inputName;
                }
                if (addGraphOutput) {
                    this._outputs.push(new KerasArgument(inputName, true, [ new KerasConnection(inputName, null, null) ]));
                }
            });
        }
        if (config.layers) {
            config.layers.forEach((layer) => {
                this._operators[layer.class_name] = (this._operators[layer.class_name] || 0) + 1; 
                if (nodeMap[layer.name]) {
                    this._loadNode(layer, layer._inputs, layer._outputs, model_weights, weightsManifest, group);
                }
            });
        }
    }

    _loadSequential(config, model_weights, weightsManifest, group, inputs, outputs) {
        if (group) {
            this._groups = true;
        }
        var inputName = 'input';
        var inputType = null;
        var connection = inputName;
        var index = 0;
        var layers = config.layers ? config.layers : config;
        layers.forEach((layer) => {
            this._operators[layer.class_name] = (this._operators[layer.class_name] || 0) + 1; 
            var name = index.toString();
            var nodeInputs = [ connection ];
            if (index == 0) {
                if (inputs && inputs.length > 0) {
                    nodeInputs = [ inputs[0] ];
                }
                else {
                    inputType = this._getInputType(layer);
                }
            }
            index++;
            if (layer.config && layer.config.name) {
                name = layer.config.name;
            }
            connection = name;
            var nodeOutputs = [ connection ];
            if (index == config.length) {
                if (outputs && outputs.length > 0) {
                    nodeOutputs = [ outputs[0] ];                    
                    connection = null;           
                }
            }

            this._loadNode(layer, nodeInputs, nodeOutputs, model_weights, weightsManifest, group);
        });
        if (!inputs) {
            this._inputs.push(new KerasArgument(inputName, true, [ new KerasConnection(inputName, inputType, null) ]));
        }
        if (connection) {
            this._outputs.push(new KerasArgument(connection, true, [ new KerasConnection(connection, null, null) ]));
        }
    }

    _loadNode(layer, inputs, outputs, model_weights, weightsManifest, group) {
        var class_name = layer.class_name;
        switch (class_name) {
            case 'Sequential':
                this._loadSequential(layer.config, model_weights, weightsManifest, layer.name, inputs, outputs);
                break;
            case 'Model':
                this._loadModel(layer.config, model_weights, weightsManifest, layer.name, inputs, outputs);
                break;
            default:
                var config = layer.config;
                this._nodes.push(new KerasNode(class_name, config, inputs, outputs, group, model_weights, weightsManifest));
                break;
        }
    }

    _getInputType(layer) {
        if (layer && layer.config) {
            var dataType = '?';
            var shape = [];
            var config = layer.config;
            if (config.dtype) {
                dataType = config.dtype;
                delete config.dtype;
            }
            if (config.batch_input_shape) {
                shape = config.batch_input_shape.map(s => s == null ? '?' : s);
                delete config.batch_input_shape;
            }
            return new KerasTensorType(dataType, shape);
        }
        return null;
    }
}

class KerasArgument {
    constructor(name, visible, connections) {
        this._name = name;
        this._visible = visible;
        this._connections = connections;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get connections() {
        return this._connections;
    }
}

class KerasConnection {
    constructor(id, type, initializer) {
        this._id = id;
        this._type = type || null;
        this._initializer = initializer || null;
    }

    get id() {
        return this._id;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
}

class KerasNode {

    constructor(operator, config, inputs, outputs, group, model_weights, weightsManifest) {
        if (group) {
            this._group = group;
        }
        this._operator = operator;
        this._config = config;
        this._inputs = inputs;
        this._outputs = outputs;
        this._attributes = [];

        if (operator == 'Bidirectional' || operator == 'TimeDistributed') {
            if (this._config && this._config.layer) {
                var inner = this._config.layer;
                this._inner = new KerasNode(inner.class_name, inner.config, [], [], null, null);
            }
        }

        var name = this.name;
        this._initializers = {};

        if (model_weights) {
            var weights = null;
            if (group) {
                weights = model_weights.group(group);
            }
            else if (config) {
                weights = model_weights.group(config.name);
            }
            if (weights) {
                var weight_names = weights.attributes.weight_names;
                if (weight_names) {
                    if (group) {
                        weight_names = weight_names.filter(weight => weight.startsWith(name + '/'));
                    }
                    weight_names.forEach((weight_name) => {
                        var weight_variable = weights.group(weight_name);
                        if (weight_variable) {
                            var variable = weight_variable.value;
                            if (variable) {
                                this._inputs.push(weight_name);
                                this._initializers[weight_name] = new KerasTensor(weight_name, variable.type, variable.shape, variable.rawData, '');
                            }
                        }
                    });
                }
            }
        }
        else if (weightsManifest) {
            var manifest = weightsManifest[name];
            if (manifest) {
                manifest.weights.forEach((weights) => {
                    if (weights.name) {
                        this._inputs.push(weights.name);
                        this._initializers[weights.name] = new KerasTensor(weights.name, weights.dtype, weights.shape, null, manifest.paths.join(';'));
                    }
                });
            } 
        }

        if (this._config) {
            Object.keys(this._config).forEach((name) => {
                var value = this._config[name];
                if (name != 'name' && value != null) {
                    this._attributes.push(new KerasAttribute(this.operator, name, value));
                }
            });
        }
    }

    get operator() {
        return this._operator;
    }

    get name() {
        if (this._config && this._config.name) {
            return this._config.name;
        }
        return '';
    }

    get group() {
        return this._group ? this._group : '';
    }

    get category() {
        var schema = KerasOperatorMetadata.operatorMetadata.getSchema(this._operator);
        return (schema && schema.category) ? schema.category : null;
    }

    get documentation() {
        var schema = KerasOperatorMetadata.operatorMetadata.getSchema(this._operator);
        if (schema) {
            schema = JSON.parse(JSON.stringify(schema));
            schema.name = this._operator;
            if (schema.description) {
                schema.description = marked(schema.description);
            }
            if (schema.attributes) {
                schema.attributes.forEach((attribute) => {
                    if (attribute.description) {
                        attribute.description = marked(attribute.description);
                    }
                });
            }
            if (schema.inputs) {
                schema.inputs.forEach((input) => {
                    if (input.description) {
                        input.description = marked(input.description);
                    }
                });
            }
            if (schema.outputs) {
                schema.outputs.forEach((output) => {
                    if (output.description) {
                        output.description = marked(output.description);
                    }
                });
            }
            if (schema.references) {
                schema.references.forEach((reference) => {
                    if (reference) {
                        reference.description = marked(reference.description);
                    }
                });
            }
            return schema;
        }
        return '';
    }

    get inputs() {
        var inputs = KerasOperatorMetadata.operatorMetadata.getInputs(this, this._inputs);
        return inputs.map((input) => {
            return new KerasArgument(input.name, input.visible != false, input.connections.map((connection) => {
                return new KerasConnection(connection.id, null, this._initializers[connection.id]);
            }));
        });
    }

    get outputs() {
        return this._outputs.map((output, index) => {
            var result = { connections: [] };
            var outputName = KerasOperatorMetadata.operatorMetadata.getOutputName(this.operator, index);
            return new KerasArgument(outputName, true, [ new KerasConnection(output, null, null) ]);            
        });
    }

    get attributes() {
        return this._attributes;
    }

    get dependencies() {
        return [];
    }

    get inner() {
        return this._inner;
    }
}

class KerasAttribute {

    constructor(operator, name, value) {
        this._name = name;
        this._value = value;

        if (typeof value == 'object' && value.class_name && value.config) {
            this._value = () => {
                return value.class_name + '(' + Object.keys(value.config).map(key => {
                    return key + '=' + JSON.stringify(value.config[key]);
                }).join(', ') + ')';
            };
        }

        if (name == 'trainable') {
            this._visible = false;
        }
        else if (name == 'layer' && (operator == 'Bidirectional' || operator == 'TimeDistributed')) {
            this._visible = false;
        }
        else {
            var schema = KerasOperatorMetadata.operatorMetadata.getAttributeSchema(operator, this._name)
            if (schema) {
                if (schema.hasOwnProperty('visible') && !schema.visible) {
                    this._visible = false;
                }
                else if (schema.hasOwnProperty('default')) {
                    if (KerasAttribute._isEquivalent(schema.default, value)) {
                        this._visible = false;
                    }
                }
            }
        }
    }

    get name() {
        return this._name;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible == false ? false : true;
    }

    static _isEquivalent(a, b) {
        if (a === b) {
            return a !== 0 || 1 / a === 1 / b;
        }
        if (a == null || b == null) {
            return false;
        }
        if (a !== a) {
            return b !== b;
        }
        var type = typeof a;
        if (type !== 'function' && type !== 'object' && typeof b != 'object') {
            return false;
        }
        var className = toString.call(a);
        if (className !== toString.call(b)) {
            return false;
        }
        switch (className) {
            case '[object RegExp]':
            case '[object String]':
                return '' + a === '' + b;
            case '[object Number]':
                if (+a !== +a) {
                    return +b !== +b;
                }
                return +a === 0 ? 1 / +a === 1 / b : +a === +b;
            case '[object Date]':
            case '[object Boolean]':
                return +a === +b;
            case '[object Array]':
                var length = a.length;
                if (length !== b.length) {
                    return false;
                }
                while (length--) {
                    if (!KerasAttribute._isEquivalent(a[length], b[length])) {
                        return false;
                    }
                }
                return true;
        }

        var keys = Object.keys(a);
        var size = keys.length;
        if (Object.keys(b).length != size) {
            return false;
        } 
        while (size--) {
            var key = keys[size];
            if (!(b.hasOwnProperty(key) && KerasAttribute._isEquivalent(a[key], b[key]))) {
                return false;
            }
        }
        return true;
    }
}

class KerasTensor {

    constructor(name, type, shape, data, reference) {
        this._name = name;
        this._type = new KerasTensorType(type, shape);
        this._data = data;
        this._reference = reference;
    }

    get kind() {
        return 'Weights';
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get reference() {
        return this._reference;
    }

    get state() {
        return this._context().state;
    }

    get value() {
        var context = this._context();
        if (context.state) {
            return null;
        }
        context.limit = Number.MAX_SAFE_INTEGER;
        return this._decode(context, 0);
    }

    toString() {
        var context = this._context();
        if (context.state) {
            return '';
        }
        context.limit = 10000;
        var value = this._decode(context, 0);
        return KerasTensor._stringify(value, '', '    ');
    }

    _context() {
        var context = {};
        context.index = 0;
        context.count = 0;
        context.state = null;
        if (this._reference) { 
            context.state = 'Tensor reference not implemented.';
            return context;
        }
        if (!this._data) {
            context.state = 'Tensor data is empty.';
            return context;
        }
        switch (this._type.dataType) {
            case 'float16':
                context.precision = 16;
                break;
            case 'float32':
                context.precision = 32;
                break;
            case 'float64':
                context.precision = 64;
                break;
            default:
                context.state = 'Tensor data type is not supported.';
                break;
        }
        context.rawData = new DataView(this._data.buffer, this._data.byteOffset, this._data.byteLength);
        return context;
    }

    _decode(context, dimension) {
        var results = [];
        var shape = this._type.shape;
        var size = shape[dimension];
        if (dimension == shape.length - 1) {
            for (var i = 0; i < size; i++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                if (context.rawData) {
                    switch (context.precision) {
                        case 16:
                            results.push(context.rawData.getFloat16(context.index, true));
                            context.index += 2;
                            break;
                        case 32:
                            results.push(context.rawData.getFloat32(context.index, true));
                            context.index += 4;
                            break;
                        case 64:
                            results.push(context.rawData.getFloat64(context.index, true));
                            context.index += 8;
                            break;
                    }
                    context.count++;
                }
            }
        }
        else {
            for (var j = 0; j < size; j++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(this._decode(context, dimension + 1));
            }
        }
        return results;
    }

    static _stringify(value, indentation, indent) {
        if (Array.isArray(value)) {
            var result = [];
            result.push(indentation + '[');
            var items = value.map((item) => KerasTensor._stringify(item, indentation + indent, indent));
            if (items.length > 0) {
                result.push(items.join(',\n'));
            }
            result.push(indentation + ']');
            return result.join('\n');
        }
        if (typeof value == 'string') {
            return indentation + value;
        }
        if (value == Infinity) {
            return indentation + 'Infinity';
        }
        if (value == -Infinity) {
            return indentation + '-Infinity';
        }
        if (isNaN(value)) {
            return indentation + 'NaN';
        }
        return indentation + value.toString();
    }
}

class KerasTensorType {

    constructor(dataType, shape) {
        this._dataType = dataType;
        this._shape = shape;
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    toString() {
        return this.dataType + (this._shape ? ('[' + this._shape.map((dimension) => dimension.toString()).join(',') + ']') : '');
    }

}

class KerasOperatorMetadata {

    static open(host, callback) {
        if (KerasOperatorMetadata.operatorMetadata) {
            callback(null, KerasOperatorMetadata.operatorMetadata);
        }
        else {
            host.request(null, 'keras-metadata.json', 'utf-8', (err, data) => {
                KerasOperatorMetadata.operatorMetadata = new KerasOperatorMetadata(data);
                callback(null, KerasOperatorMetadata.operatorMetadata);
            });    
        }
    }

    constructor(data) {
        this._map = {};
        if (data) {
            var items = JSON.parse(data);
            if (items) {
                items.forEach((item) => {
                    if (item.name && item.schema)
                    {
                        this._map[item.name] = item.schema;
                    }
                });
            }
        }
    }

    getSchema(operator) {
        return this._map[operator] || null;
    }

    getInputs(node, inputs) {
        var results = [];
        var operator = node.operator;
        var schema = this.getSchema(operator);
        var inner = node.inner;
        var innerOperator = inner ? inner.operator : null;
        var innerSchema = innerOperator ? this._map[innerOperator] : null;
        var index = 0;
        while (index < inputs.length) {
            var result = { connections: [] };
            var count = 1;
            var name = null;
            if (!innerSchema || index == 0)
            {
                if (schema && schema.inputs && index < schema.inputs.length) {
                    var input = schema.inputs[index];
                    name = input.name;
                    if (schema.inputs[index].option == 'variadic') {
                        count = inputs.length - index;
                    }
                }
            }
            else {
                switch (operator) {
                    case 'Bidirectional':
                        var innerIndex = index;
                        if (innerSchema && innerSchema.inputs) {
                            if (innerIndex < innerSchema.inputs.length) {
                                name = 'forward_' + innerSchema.inputs[innerIndex].name;
                            }
                            else {
                                innerIndex = innerIndex - innerSchema.inputs.length + 1;
                                if (innerIndex < innerSchema.inputs.length) {
                                    name = 'backward_' + innerSchema.inputs[innerIndex].name;
                                }
                            }
                        }
                        result.visible = false;
                        break;
                    case 'TimeDistributed':
                        if (innerSchema && innerSchema.inputs && index < innerSchema.inputs.length) {
                            name = innerSchema.inputs[index].name;
                        }
                        break;
                }
            }
            result.name = name ? name : '(' + index.toString() + ')';
            var array = inputs.slice(index, index + count);
            for (var j = 0; j < array.length; j++) {
                result.connections.push({ id: array[j] });
            }
            index += count;
            results.push(result);
        }
        return results;
    }

    getOutputName(operator, index) {
        var schema = this.getSchema(operator);
        if (schema) {
            var outputs = schema.outputs;
            if (outputs && index < outputs.length) {
                var output = outputs[index];
                if (output) {
                    var name = output.name;
                    if (name) {
                        return name;
                    }
                } 
            }
        }
        return '(' + index.toString() + ')';
    }

    getAttributeSchema(operator, name) {
        var schema = this.getSchema(operator);
        if (schema && schema.attributes && schema.attributes.length > 0) {
            if (!schema.attributeMap) {
                schema.attributeMap = {};
                schema.attributes.forEach(attribute => {
                    schema.attributeMap[attribute.name] = attribute;
                });
            }
            return schema.attributeMap[name] || null;
        }
        return null;
    }
}

class KerasError extends Error {
    constructor(message) {
        super(message);
        this.name = 'Error loading Keras model.';
    }
}