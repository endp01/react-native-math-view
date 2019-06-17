'use strict';
import AsyncStorage from '@react-native-community/async-storage';
import EventEmitter from 'events';
import * as _ from 'lodash';
import PropTypes from 'prop-types';
import React, { Component } from 'react';
import { AppState, findNodeHandle, NativeModules, Platform, requireNativeComponent, UIManager } from 'react-native';

const nativeViewName = 'RNMathJaxProvider';
const RNMathJaxProvider = requireNativeComponent(nativeViewName, Provider, {
    nativeOnly: {
        nativeID: true
    }
});
const ViewManager = NativeModules.RNMathViewManager || {};
export const { Constants } = UIManager.getViewManagerConfig ? UIManager.getViewManagerConfig(nativeViewName) : UIManager[nativeViewName];
const ViewModule = Platform.OS === 'ios' ? ViewManager : NativeModules.RNMathViewModule;

class CacheHandler {
    active = false;
    static cache = [];
    static tags = [];
    static sharedConfig = {
        disabled: false,
        warning: true,
        maxTimeout: 10000
    }
    disabled = false;
    warning = true;
    maxTimeout = 10000;
    storageKey = 'MathJaxProviderCache';
    viewTag = null;
    eventEmitter = new EventEmitter();
    isGlobal = false

    constructor(isGlobal = false) {
        this.appState = AppState.currentState;
        this.eventEmitter.setMaxListeners(1000);
        _.map(CacheHandler.sharedConfig, (val, key) => _.set(this, key, val));
        this.getCache();
    }

    //  AsyncStorage

    getAllKeys() {
        return AsyncStorage
            .getAllKeys()
            .then((keys) => {
                return keys.filter((key) => key.startsWith(this.storageKey));
            });
    }

    fetchFromDatabase() {
        return this.getAllKeys()
            .then((cacheKeys) => {
                return AsyncStorage
                    .multiGet(cacheKeys)
                    .then((response) => {
                        return response.map((value) => {
                            const [storageKey, data] = value;
                            return JSON.parse(data);
                        });
                    });
            });
    }

    setDatabaseItem(data) {
        return AsyncStorage
            .setItem(`${this.storageKey}:${data.math}`, JSON.stringify(data))
            .catch(err => {
                if (err.code === 13) this.clearDatabase();
                console.error(err);
            });
    }

    clearDatabase() {
        return this.getAllKeys()
            .then((cacheKeys) => {
                return AsyncStorage
                    .multiRemove(cacheKeys);
            });
    }

    //  CacheManager

    getCache() {
        return Promise.resolve()
            .then(async () => {
                if (AsyncStorage) {
                    const response = await this.fetchFromDatabase();
                    if (!response) return;
                    CacheHandler.cache = response;

                    if (!this.active) {
                        this.active = true;
                        this.eventEmitter.emit('cache');
                    }

                    return response;
                }
            })
            .catch(err => console.error(err));
    }

    addToCache(data) {
        if (this.disabled) console.error('MathJaxProvider.CacheManager is disabled');
        return this.updateCache(data);
    }

    updateCache(data) {
        const response = _.filter(data, (val) => _.has(val, 'svg'));
        CacheHandler.cache.push(...response);
        response.map((val) => this.eventEmitter.emit(val.math, val));
        return Promise.resolve(AsyncStorage && !this.disabled ? _.map(response, (val) => this.setDatabaseItem(val)) : false);
    }

    clearCache() {
        CacheHandler.cache = [];
        return Promise.resolve(AsyncStorage ? this.clearDatabase() : false);
    }

    isCached(key) {
        return !_.isNil(_.find(CacheHandler.cache, (val) => val && _.isEqual(val.math, key)));
    }

    enable() {
        this.disabled = false;
        if (this.isGlobal) CacheHandler.sharedConfig.disabled = false;
    }

    disable() {
        this.disabled = true;
        if (this.isGlobal) CacheHandler.sharedConfig.disabled = true;
    }

    //  RequestManager

    disableWarnings() {
        this.warning = false;
        if (this.isGlobal) CacheHandler.sharedConfig.warning = false;
    }

    setMaxTimeout(timeout) {
        this.maxTimeout = timeout;
        if (this.isGlobal) CacheHandler.sharedConfig.maxTimeout = timeout;
    }

    async handleRequest(math) {
        const request = Array.isArray(math) ? math : [math];
        await new Promise((resolve, reject) => {
            const callback = () => !_.isNil(this.viewTag) && resolve();
            callback();
            this.eventEmitter.once('provider', callback);
            setTimeout(() => {
                this.eventEmitter.removeListener('provider', callback);
                reject('timeout: Could not find MathJax.Provider');
            }, this.maxTimeout);
        });
        try {
            const response = await ViewModule.getMathJax(this.viewTag, request, { timeout: this.maxTimeout });
            this.updateCache(response);
            return response;
        }
        catch (err) {
            if (this.warning) {
                console.warn(err.message || err);
            }
            else {
                console.log(err);
            }
            return [];
        }
    }

    async fetch(math, timeout = this.maxTimeout) {
        const isArr = Array.isArray(math);
        const arr = isArr ? math : [math];
        const fetchFromNative = _.reject(arr, this.isCached);
        if (_.size(fetchFromNative) > 0) {
            const canResolve = () => !_.every(fetchFromNative, this.isCached);
            await Promise.race([
                new Promise((resolve) => {
                    if (this.active && canResolve) resolve();
                    this.eventEmitter.once('cache', () => canResolve() && resolve());
                }),
                this.handleRequest(fetchFromNative)
            ]);
        }

        const response = _.map(arr, (val) => _.find(CacheHandler.cache, (o) => o && _.isEqual(o.math, val)));
        return isArr ? response : response[0];
    }

    onReady(math, callback) {
        const result = _.find(CacheHandler.cache, (val) => val.math === math);

        if (result) {
            callback(result);
            return () => { };
        }
        else {
            this.eventEmitter.once(math, callback);
            this.fetch(math);
            return () => {
                try {
                    this.eventEmitter.removeListener(math, callback);
                }
                catch (err) {
                    console.log(err);
                }
            };
        }
    }

    setViewTag(next, prev) {
        _.pull(CacheHandler.tags, prev);
        if (next) CacheHandler.tags.push(next);
        this.viewTag = next;
        if (CacheManager.viewTag === prev) CacheManager.viewTag = CacheHandler.tags[0];
        this.eventEmitter.emit('provider', this.viewTag);
    }
}

export const CacheManager = new CacheHandler(true);

export const Context = React.createContext(CacheHandler);

export class Provider extends Component {
    static propTypes = {
        onLayout: PropTypes.func,
        preload: PropTypes.oneOfType([PropTypes.arrayOf(PropTypes.string), PropTypes.string])
    }

    tag = null;

    constructor(props) {
        super(props);
        this.cacheManager = new CacheHandler();        
        props.preload && this.cacheManager.fetch(props.preload);
    }

    static getDerivedStateFormProps(nextProps) {
        this.cacheManager.fetch(nextProps.preload);
        return null;
    }

    _handleRef = (ref) => {
        const tag = ref ? findNodeHandle(ref) : null;
        this.cacheManager.setViewTag(tag, this.tag);
        this.tag = tag;
    }

    preload(math) {
        return this.cacheManager.fetch(math);
    }

    clear() {
        return this.cacheManager.clearCache();
    }

    getCacheManager() {
        return this.cacheManager;
    }

    render() {
        return (
            <>
                <RNMathJaxProvider
                    ref={this._handleRef}
                    onLayout={this.props.onLayout}
                />
                <Context.Provider
                    value={this.cacheManager}
                >
                    {this.props.children}
                </Context.Provider>
            </>
        );
    }
}


