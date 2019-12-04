// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Silei Xu <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

// This file is meant to be used as an entry point to a browserify
// bundle
// we can use commonjs but no nodejs deps

const assert = require('assert');

const ThingTalk = require('thingtalk');
const Ast = ThingTalk.Ast;
const SchemaRetriever = ThingTalk.SchemaRetriever;
const ThingpediaClient = require('./deps/thingpediaclient');


function fullCanonical(schema, type) {
    let canonical = schema.canonical || schema.name;
    assert(type === 'stream' || type === 'query' || type === 'action');
    if (type === 'action')
        return canonical;

    if (canonical.startsWith('get '))
        canonical = canonical.slice('get '.length);
    if (type === 'query')
        return `get ${canonical}`;
    if (type === 'stream')
        return `when ${canonical} changes`;
}

function prettyprintComponent(ast, type) {
    assert(type === 'stream' || type === 'query' || type === 'action');
    if (type === 'stream') {
        let rule = new Ast.Statement.Rule(ast, [ThingTalk.Generate.notifyAction()]);
        return new Ast.Input.Program([], [], [rule]).prettyprint().split('=>')[0];
    } else if (type === 'query') {
        let command = new Ast.Statement.Command(ast, [ThingTalk.Generate.notifyAction()]);
        return new Ast.Input.Program([], [], [command]).prettyprint().split('=>')[1];
    } else {
        let command = new Ast.Statement.Command(null, [ast]);
        return new Ast.Input.Program([], [], [command]).prettyprint().split('=>')[1];
    }
}

function resolveValue(type, value, isVarRef=false) {
    if (isVarRef)
        return Ast.Value.VarRef(value);
    if (type.isString)
        return Ast.Value.String(value);
    if (type.isNumber && !isNaN(value))
        return Ast.Value.Number(parseInt(value));
    if (type.isEnum)
        return Ast.Value.Enum(value);
    if (type.isLocation && value.startsWith('$'))
        return new Ast.Value.Location(new Ast.Location.Relative(value.slice(1)));
    if (type.isBoolean)
        return new Ast.Value.Boolean(value === 'true');
    if (type.isEntity)
        return Ast.Value.Entity(value, type.type, null);

    throw new Error('Not supported type');
}

function comboInput(candidates, id) {
    let combo = $('<div>');
    let inputGroup = $('<div>').addClass('input-group');
    let input = $('<input>').addClass('form-control').attr('id', id);
    let dropdown = $('<div>').addClass('input-group-btn');
    let button = $('<button>').addClass('btn').addClass('btn-outline-secondary').addClass('dropdown-toggle').attr('data-toggle', 'dropdown');
    button.append($('<i>').addClass('fas').addClass('fa-caret-down'));
    let dropdownMenu = $('<ul>').addClass('dropdown-menu').addClass('dropdown-menu-right');
    for (let name in candidates) {
        let li = $('<li>').addClass('dropdown-item');
        let candidate = $('<a>').text(candidates[name]);
        candidate.click(() => {
            input.attr('placeholder', candidates[name]).prop('disabled', true).val(name);
            input.attr('isVarRef', 'true');
        });
        li.append(candidate);
        dropdownMenu.append(li);
    }
    let li = $('<li>').addClass('dropdown-item');
    let reset = $('<a>').text('Type your own');
    reset.click(() => {
        input.prop('disabled', false).val('');
    });
    li.append(reset);

    dropdownMenu.append(li);
    dropdown.append(button);
    dropdown.append(dropdownMenu);
    inputGroup.append(input);
    inputGroup.append(dropdown);
    combo.append(inputGroup);
    return combo;
}

function inputByType(type, candidates, id) {
    if (type.isString || type.isNumber || type.isEntity) {
        if (Object.keys(candidates).length === 0)
            return $('<input>').addClass('form-control').attr('id', id);
        else
            return comboInput(candidates, id);
    }

    if (type.isEnum) {
        let selector = $('<select>').addClass('form-control').attr('id', id);
        for (let entry of type.entries)
            selector.append($('<option>').text(entry));
        for (let name in candidates)
            selector.append($('<option>').text(candidates[name]).attr('isVarRef', 'true')).val(name);
        return selector;
    }

    if (type.isLocation) {
        let selector = $('<select>').addClass('form-control').attr('id', id);
        selector.append($('<option>').text('home').val('$home'));
        selector.append($('<option>').text('work').val('$work'));
        selector.append($('<option>').text('here').val('$current_location'));
        for (let name in candidates)
            selector.append($('<option>').text(candidates[name]).attr('isVarRef', 'true')).val(name);
        return selector;
    }

    if (type.isBoolean) {
        let selector = $('<select>').addClass('form-control').attr('id', id);
        selector.append($('<option>').text('true'));
        selector.append($('<option>').text('false'));
        for (let name in candidates)
            selector.append($('<option>').text(candidates[name]).attr('isVarRef', 'true')).val(name);
        return selector;
    }


    //TODO: add support for more types
    return $('<input>').addClass('form-control').attr('placeholder', 'Not supported type').prop( "disabled", true );
}

class ThingTalkBuilder {
    constructor() {
        this._locale = document.body.dataset.locale || 'en-US';

        this._developerKey = document.body.dataset.developerKey || null;
        this._user = document.body.dataset.cloudId || null;
        this.thingpedia = new ThingpediaClient(this._developerKey, this._locale);
        this._schemaRetriever = new SchemaRetriever(this.thingpedia);

        this._stream = null;
        this._query = null;
        this._action = null;
        this._streamInvocation = null;
        this._queryInvocation = null;
        this._actionInvocation = null;

        this._streamCanonical = null;
        this._queryCanonical = null;
        this._actionCanonical = null;

        // output grouped by type
        this._streamOutput = {};
        this._queryOutput = {};

        // track which type the user is currently editing
        this._currentType = null;

        // the <div> containing all devices matches the search result
        this._deviceDiv = $('#device-result');
        this._deviceCandidates = $('#device-candidates');
        this._deviceSearchHint = $('#search-result-hint');
        // the <div> containing all examples of the chosen device
        this._exampleDiv = $('#example-result');
        this._exampleCandidates = $('#example-candidates');
        this._exampleListHint = $('#example-list-hint');

        // the <div> containing input params of a chosen function
        this._inputParamsCandidates = $('#thingtalk-add-input-edit');

        // the <div> containing filter candidates of a chosen function
        this._filterCandidates = $('#thingtalk-add-filter-edit');

        // the thingtalk output
        this._thingtalkOutput = $('#thingtalk-output');

        // clear input field
        $('#thingtalk-when').val('');
        $('#thingtalk-get').val('');
        $('#thingtalk-do').val('');
        this._thingtalkOutput.val('');
    }

    get function() {
        if (this._currentType === 'stream')
            return this._stream;
        else if (this._currentType === 'query')
            return this._query;
        else if (this._currentType === 'action')
            return this._action;
        else
            throw new Error('Unexpected type');
    }

    searchDevice(key) {
        return this.thingpedia.searchDevice(key);
    }

    async showDevices(devices) {
        this._resetDeviceCandidates(false);
        this._resetExampleCandidates();
        for (let d of devices) {
            const parsed = ThingTalk.Grammar.parse(await this.thingpedia.getDeviceCode(d.primary_kind));
            const device = parsed.classes[0];
            const candidate = $('<button>').addClass('btn').addClass('btn-default').text(d.name);
            candidate.click(async () => {
                this.showFunctions(device);
            });
            this._deviceCandidates.append(candidate);
        }
        if (devices.length === 0)
            this._deviceSearchHint.text('No device found');
        else
            this._deviceSearchHint.text('Do you mean?');
    }

    showFunctions(deviceClass) {
        assert(this._currentType === 'stream' || this._currentType === 'query' || this._currentType === 'action');

        this._resetExampleCandidates(false);

        const functions = this._currentType === 'action' ? deviceClass.actions : deviceClass.queries;
        for (let f of Object.values(functions)) {
            // skip non-monitorable functions for stream
            if (this._currentType === 'stream' && !f.is_monitorable)
                continue;

            let canonical = fullCanonical(f, this._currentType);
            let candidate = $('<button>').addClass('btn').addClass('btn-default').text(canonical);
            candidate.click(() => {
                this._updateFunction(deviceClass, f);
            });
            this._exampleCandidates.append(candidate);
        }

        if (this._exampleCandidates.length === 0)
            this._exampleListHint.text('No compatible example found for this device.');
        else
            this._exampleListHint.text('Choose the function you want to use:');
    }

    _updateFunction(deviceClass, functionSignature) {
        const invocation = new Ast.Invocation(
            new Ast.Selector.Device(deviceClass.kind, null, null), functionSignature.name, [], functionSignature
        );
        if (this._currentType === 'stream') {
            this._streamCanonical = fullCanonical(functionSignature, this._currentType);
            this._streamInvocation = new Ast.Table.Invocation(invocation, invocation.schema);
            this._stream = new Ast.Stream.Monitor(this._streamInvocation, [], invocation.schema);
        } else if (this._currentType === 'query') {
            this._queryCanonical = fullCanonical(functionSignature, this._currentType);
            this._queryInvocation = new Ast.Table.Invocation(invocation, invocation.schema);
            this._query = this._queryInvocation;
        } else if (this._currentType === 'action') {
            this._actionCanonical = fullCanonical(functionSignature, this._currentType);
            this._actionInvocation = new Ast.Action.Invocation(invocation, invocation.schema);
            this._action = this._actionInvocation;
        }

        this._updateOutput(invocation.schema);
        this._updateThingTalk();

        $('#thingtalk-select').modal('toggle');
    }

    _updateThingTalk() {
        if (this._currentType === 'stream')
            $('#thingtalk-when').val(prettyprintComponent(this._stream, 'stream'));
        else if (this._currentType === 'query')
            $('#thingtalk-get').val(prettyprintComponent(this._query, 'query'));
        else if (this._currentType === 'action')
            $('#thingtalk-do').val(prettyprintComponent(this._action, 'action'));

        this._thingtalkOutput.val(this._prettyprint());
    }

    _updateOutput(schema) {
        if (this._currentType === 'stream') {
            this._streamOutput = {};
            for (let arg of schema.iterateArguments()) {
                if (arg.is_input)
                    continue;
                let type = arg.type.toString();
                if (type in this._streamOutput)
                    this._streamOutput[type].add(arg.name);
                else
                    this._streamOutput[type] = new Set([arg.name]);
            }
        } else if (this._currentType === 'query') {
            this._queryOutput = {};
            for (let arg of schema.iterateArguments()) {
                if (arg.is_input)
                    continue;
                let type = arg.type.toString();
                if (type in this._queryOutput)
                    this._queryOutput[type].add(arg.name);
                else
                    this._queryOutput[type] = new Set([arg.name]);
            }
        }
    }


    showInputParams() {
        this._resetInputParamCandidates();

        for (let arg of this.function.schema.iterateArguments()) {
            if (arg.is_input)
                this._addInputCandidate(arg);
        }
    }

    _addInputCandidate(arg) {
        let row = $('<div>').addClass('row');
        let nameDiv = $('<div>').addClass('col-lg-4');
        nameDiv.append($('<p>').addClass('form-control').text(arg.name));

        let opDiv = $('<div>').addClass('col-lg-3');
        opDiv.append($('<p>').addClass('form-control').text('='));

        let ppCandidates = this._parameterPassingCandidates(arg.type);
        let valueDiv = $('<div>').addClass('col-lg-4');
        valueDiv.append(inputByType(arg.type, ppCandidates, `thingtalk-input-value-${arg.name}`));

        row.append(nameDiv);
        row.append(opDiv);
        row.append(valueDiv);

        this._inputParamsCandidates.append(row);
    }

    updateInput() {
        let values = {};
        for (let arg of this.function.schema.iterateArguments()) {
            if (arg.is_input) {
                let input = $(`#thingtalk-input-value-${arg.name}`);
                let value = input.val();
                if (value)
                    values[arg.name] = resolveValue(arg.type, value, input.attr('isvarref') === 'true');
            }
        }

        if (Object.keys(values).length > 0) {
            let invocation;
            if (this._currentType === 'stream')
                invocation = this._streamInvocation.invocation;
            else if (this._currentType === 'query')
                invocation = this._queryInvocation.invocation;
            else if (this._currentType === 'action')
                invocation = this._actionInvocation.invocation;
            else
                throw new Error('Invalid type');
            let in_params = [];
            for (let name in values) {
                in_params.push({
                    name, value: values[name]
                });
            }
            invocation.in_params = in_params;
            this._updateThingTalk();
        }
    }

    showFilters() {
        this._resetFilterCandidates();
        for (let arg of this.function.schema.iterateArguments()) {
            if (!arg.is_input)
                this._addFilterCandidate(arg);
        }
    }

    _addFilterCandidate(arg) {
        let row = $('<div>').addClass('row');
        let nameDiv = $('<div>').addClass('col-lg-4');
        nameDiv.append($('<p>').addClass('form-control').text(arg.name));

        let opDiv = $('<div>').addClass('col-lg-3');
        let selector = $('<select>').addClass('form-control').attr('id', `thingtalk-filter-op-${arg.name}`);
        if (arg.type.isNumber) {
            selector.append($('<option>').text('=='));
            selector.append($('<option>').text('>='));
            selector.append($('<option>').text('<='));
        } else if (arg.type.isString) {
            selector.append($('<option>').text('contains').val('=~'));
        } else {
            selector.append($('<option>').text('=='));
        }
        opDiv.append(selector);

        let ppCandidates = this._parameterPassingCandidates(arg.type);
        let valueDiv = $('<div>').addClass('col-lg-4');
        valueDiv.append(inputByType(arg.type, ppCandidates, `thingtalk-filter-value-${arg.name}`));

        row.append(nameDiv);
        row.append(opDiv);
        row.append(valueDiv);
        this._filterCandidates.append(row);
    }

    async updateFilter() {
        let atoms = [];
        for (let arg of this.function.schema.iterateArguments()) {
            if (!arg.is_input) {
                let input = $(`#thingtalk-filter-value-${arg.name}`);
                let value = input.val();
                if (!value)
                    continue;

                value = resolveValue(arg.type, value, input.attr('isvarref') === 'true');
                let op = $(`#thingtalk-filter-op-${arg.name}`).val();

                atoms.push(new Ast.BooleanExpression.Atom(arg.name, op, value));
            }
        }

        let filter;
        if (atoms.length === 1)
            filter = atoms[0];
        else if (atoms.length > 1)
            filter = new Ast.BooleanExpression.And(atoms);

        if (filter) {
            if (this._currentType === 'stream')
                this._stream = new Ast.Stream.EdgeFilter(this._stream, filter, this._stream.schema);
            else
                this._query = new Ast.Table.Filter(this._query, filter, this._query.schema);
        }

        this._updateThingTalk();
    }


    _prettyprint() {
        let rule;
        if (!this._stream && !this._query && !this._action)
            return 'Please choose at least one function.';
        let stream = this._stream;
        let query = this._query;
        let action = this._action ? this._action : ThingTalk.Generate.notifyAction();
        if (stream && query) {
            rule = new Ast.Statement.Rule(
                new Ast.Stream.Join(stream, query, [], null), [action]
            );
        } else if (stream) {
            rule = new Ast.Statement.Rule(stream, [action]);
        } else {
            rule = new Ast.Statement.Command(query, [action]);
        }
        return new Ast.Input.Program([], [], [rule]).prettyprint();
    }

    _parameterPassingCandidates(type) {
        let candidates = {};
        if (this._currentType === 'stream')
            return candidates;
        if (this._currentType === 'query') {
            if (type.toString() in this._streamOutput) {
                for (let pname of this._streamOutput[type.toString()])
                    candidates[pname] = `Use ${pname} from ${this._streamCanonical}`;
            }
            return candidates;
        }
        if (this._currentType === 'action') {
            if (type.toString() in this._queryOutput) {
                for (let pname of this._queryOutput[type.toString()])
                    candidates[pname] = `Use ${pname} from ${this._queryCanonical}`;
            }
            if (type.toString() in this._streamOutput) {
                for (let pname of this._streamOutput[type.toString()]) {
                    if (!(pname in candidates))
                        candidates[pname] = `Use ${pname} from ${this._streamCanonical}`;
                }
            }
            return candidates;
        }
        return candidates;
    }

    reset(type) {
        $('#thingtalk-search-device-input').val('');
        this._currentType = type;
        this._resetDeviceCandidates();
        this._resetExampleCandidates();
    }

    _resetDeviceCandidates(hide = true) {
        if (hide)
            this._deviceDiv.hide();
        else
            this._deviceDiv.show();
        this._deviceCandidates.empty();
    }

    _resetExampleCandidates(hide = true) {
        if (hide)
            this._exampleDiv.hide();
        else
            this._exampleDiv.show();
        this._exampleCandidates.empty();
    }

    _resetInputParamCandidates() {
        this._inputParamsCandidates.empty();
    }

    _resetFilterCandidates() {
        this._filterCandidates.empty();
    }
}


$(() => {
    const builder = new ThingTalkBuilder();

    $('#thingtalk-when-select').click(() => {
        builder.reset('stream');
        $('#thingtalk-select').modal('show');
    });
    $('#thingtalk-get-select').click(() => {
        builder.reset('query');
        $('#thingtalk-select').modal('show');
    });
    $('#thingtalk-do-select').click(() => {
        builder.reset('action');
        $('#thingtalk-select').modal('show');
    });

    $('#thingtalk-when-add-input').click(() => {
        builder.reset('stream');
        $('#thingtalk-add-input').modal('show');
    });
    $('#thingtalk-get-add-input').click(() => {
        builder.reset('query');
        $('#thingtalk-add-input').modal('show');
    });
    $('#thingtalk-do-add-input').click(() => {
        builder.reset('action');
        $('#thingtalk-add-input').modal('show');
    });

    $('#thingtalk-when-add-filter').click(() => {
        builder.reset('stream');
        $('#thingtalk-add-filter').modal('show');
    });
    $('#thingtalk-get-add-filter').click(() => {
        builder.reset('query');
        $('#thingtalk-add-filter').modal('show');
    });
    $('#thingtalk-do-add-filter').click(() => {
        builder.reset('action');
        $('#thingtalk-add-filter').modal('show');
    });


    $('#thingtalk-search-device').click(async () => {
        const key = $('#thingtalk-search-device-input').val();
        const devices = await builder.searchDevice(key);
        await builder.showDevices(devices.data);
    });

    $('#thingtalk-add-input').on('shown.bs.modal', () => {
        builder.showInputParams();
    });

    $('#thingtalk-add-input-submit').click(() => {
        builder.updateInput();
        $('#thingtalk-add-input').modal('toggle');
    });

    $('#thingtalk-add-filter').on('shown.bs.modal', async () => {
        await builder.showFilters();
    });

    $('#thingtalk-add-filter-submit').click(async () => {
        await builder.updateFilter();
        $('#thingtalk-add-filter').modal('toggle');
    });
});
