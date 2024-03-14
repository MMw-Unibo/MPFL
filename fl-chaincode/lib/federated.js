'use strict';

const { Contract } = require('fabric-contract-api');
const pako = require('pako')
const nj = require('@d4c/numjs').default
const tf = require('@tensorflow/tfjs');



const { 
    initializeWasm, 
    PositiveAccumulator, 
    Accumulator } = require("@docknetwork/crypto-wasm-ts");


function zip(arrays) {
    return arrays[0].map(function(_,i){
        return arrays.map(function(array){return array[i]})
    });
}

function mean(arrays) {
    var temp = arrays[0]
    for (var i = 1; i < arrays.length; i++)
        temp = nj.add(temp, arrays[i])
    return temp.divide(arrays.length).tolist()
}

function incremental_mean(zipped_layers, count) {
    var newGM = []
    for (var layer of zipped_layers) {
        var currentMean = nj.array(layer[0])
        var currentModel = nj.array(layer[1])
        newGM.push(currentMean.add((currentModel.subtract(currentMean)).divide(count + 1)).tolist())
    }
    return newGM
}


function generate_quantization_constants(alpha, beta, alpha_q, beta_q) {
    var s = (beta - alpha) / (beta_q - alpha_q)
    var z = parseInt((beta * alpha_q - alpha * beta_q) / (beta - alpha))
    return [s, z]
}


function generate_quantization_int8_constants(alpha, beta) {
    var b = 8
    var alpha_q = -(2**(b - 1))
    var beta_q = 2**(b - 1) - 1

    return generate_quantization_constants(alpha, beta, alpha_q, beta_q)
}

function find_min_max(weights) {
    var min = 0
    var max = 0
    for(var l of weights){
        var min_t = nj.min(l)
        var max_t = nj.max(l)
        if (min_t < min)
            min = min_t
        if (max_t > max)
            max = max_t
    }
    return [min, max]
}


function quantization(x, s, z, alpha_q, beta_q) {
    var x_q = nj.round(nj.add(nj.multiply(x, 1/s),z))
    x_q = nj.clip(x_q, alpha_q, beta_q)

    return x_q.tolist()
}


function quantization_int8(x, s, z) {
    var x_q = quantization(x, s, z, -128, 127)

    return x_q
}

function quantization_layers_int8(model) {
    var model_q = []
    var parameters = []
    for(var l of model){
        var min = nj.min(l)
        var max = nj.max(l)
        var s_z = generate_quantization_int8_constants(min, max)
        model_q.push(quantization_int8(l, s_z[0], s_z[1]))
        parameters.push(s_z)
    }
    return [parameters, model_q]
}


function dequantization(x_q, s, z) {
    var x = nj.subtract(x_q,z).multiply(s)

    return x.tolist()
}

function dequantization_layers(parameters, model) {
    var res = []
    for(var i in model)
        res.push(dequantization(model[i], parameters[i][0], parameters[i][1]))
    return res
}




class Federated extends Contract {

    


    async Init(ctx) {
        const partialModelsIDs = []
        await ctx.stub.putState("generalModelVersion", JSON.stringify(0))
        await ctx.stub.putState("partialModelsIDs", JSON.stringify(partialModelsIDs));

        return "Ledger initialized"

    }

    async ReadGeneralModel(ctx) {
        var generalModel = await ctx.stub.getState("generalModel")
        if (!generalModel) {
            throw new Error(`The general model does not exist`);
        }
        generalModel = JSON.parse(pako.inflate(generalModel, { to: 'string' }))
        var generalModelVersion = await ctx.stub.getState("generalModelVersion")
        generalModelVersion = JSON.parse(generalModelVersion)
        return JSON.stringify([generalModelVersion, generalModel])
    }

    async PublishPartialModel(ctx, partialModel) {

        var generalModelVersion = await ctx.stub.getState("generalModelVersion")
        generalModelVersion = JSON.parse(generalModelVersion)
        partialModel = JSON.parse(partialModel)


        if (generalModelVersion !== partialModel.version) {
            return "Error";
        } else {
            var clientID = partialModel.clientID
            
            await ctx.stub.putState("partialModel" + clientID, pako.deflate(JSON.stringify([partialModel.parameters, partialModel.model])))
            var partialModelsIDs = await ctx.stub.getState("partialModelsIDs")
            partialModelsIDs = JSON.parse(partialModelsIDs)
            
            if(partialModelsIDs.length + 1 === 2) {
                console.log("here")
                await initializeWasm();               
                // Generating a keypair
                var paramsRandom = PositiveAccumulator.generateParams(partialModelsIDs);
                const keypair = PositiveAccumulator.generateKeypair(paramsRandom, partialModelsIDs);
                var sk      = keypair.sk
                var pk      = keypair.pk
                console.log("here1")

                // Initialize the accumulator
                var accumulator = PositiveAccumulator.initialize(paramsRandom);
                console.log("here2")

                const encoder = new TextEncoder();  

                var currentModel = dequantization_layers(partialModel.parameters, partialModel.model)
                var elements = []
                const jsonModel = JSON.stringify(currentModel) 
                const bytes = encoder.encode(jsonModel); 
                elements.push(Accumulator.encodeBytesAsAccumulatorMember(bytes)); 
                var count = 0
                var newGM = currentModel;
                var start = 0
                var end = 0
                var lapsEncode = 0
                for(var id of partialModelsIDs) {
                    var parameters_model = await ctx.stub.getState("partialModel"+id)
                    parameters_model = JSON.parse(pako.inflate(parameters_model, {to:"string"}))
                    currentModel = dequantization_layers(parameters_model[0], parameters_model[1])
                    var zipped_layers = zip([newGM, currentModel])
                    newGM = incremental_mean(zipped_layers, count)
                    count++;
                    start = Date.now()
                    const jsonModel = JSON.stringify(currentModel) //
                    const bytes = encoder.encode(jsonModel); //
                    elements.push(Accumulator.encodeBytesAsAccumulatorMember(bytes)); //
                    end = Date.now()
                    lapsEncode += (end - start)
                }

                console.log("lapsEncode")
                console.log(lapsEncode)
                start = Date.now()
                await accumulator.addBatch(elements, sk);
                end = Date.now()
                var lapsAcc = end - start
                
                console.log("lapsAcc")
                console.log(lapsAcc)
                
                start = Date.now()
                var witnesses = await accumulator.membershipWitnessesForBatch(elements, sk);
                end = Date.now()
                var lapsWit = end - start
                console.log("lapsWit")
                console.log(lapsWit)
                var parameters_newGM = quantization_layers_int8(newGM)
                await ctx.stub.putState("generalModelVersion", JSON.stringify(generalModelVersion + 1))
                await ctx.stub.putState("generalModel", pako.deflate(JSON.stringify(parameters_newGM)));
                await ctx.stub.putState("partialModelsIDs", JSON.stringify([]));
                const witnessValues = witnesses.map(witness => witness.value);

                // Create a string by joining all the witness values
                const witnessString = JSON.stringify(witnessValues)
                ctx.stub.setEvent('general_model_published')


                
                return 'Model published and new general model published. Accumulator value: ' + JSON.stringify(accumulator.value) + '. Witnesses: ' + witnessString

            } else {
                partialModelsIDs.push(clientID)
                
                await ctx.stub.putState("partialModelsIDs", JSON.stringify(partialModelsIDs));

                return 'Model published'
            }
        
        }

    }

    async ReadPartialModels(ctx) {
        var partialModels = await ctx.stub.getState("partialModels")
        partialModels = JSON.parse(partialModels)
        if (!partialModels) {
            throw new Error(`There are no partial models`);
        }
        return JSON.stringify(partialModels)
    }

}




module.exports.Federated = Federated
