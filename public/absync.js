(function( undefined ) {
	"use strict";

	/**
	 * Please make note of the following conventions:
	 * 1. Function-scope local variables must be prefixed with a single underscore.
	 *    This indicates a temporary variable.
	 * 2. Private variables that are persisted onto publicly accessible entities must be prefixed with two underscores.
	 *    This indicates a publicly visible, private variable.
	 *    Hiding private variables, by using closures, is discouraged.
	 *    Modifying these values from outside of absync is discouraged, but should be respected whenever possible.
	 */

	angular
		.module( "absync" )
		.provider( "absync", getAbsyncProvider );

	/**
	 * Retrieves the absync provider.
	 * @param {angular.auto.IProvideService|Object} $provide The $provide provider
	 * @ngInject
	 */
	function getAbsyncProvider( $provide ) {
		return new AbsyncProvider( $provide );
	}

	/**
	 * Retrieves the absync provider.
	 * @param {angular.auto.IProvideService|Object} $provide The $provide provider
	 * @constructor
	 */
	function AbsyncProvider( $provide ) {
		var _absyncProvider = this;

		// Store a reference to the provide provider.
		_absyncProvider.__provide = $provide;

		// A reference to the socket.io instance we're using to receive updates from the server.
		_absyncProvider.__ioSocket = null;
		// We usually register event listeners on the socket.io instance right away.
		// If socket.io was not connected when a service was constructed, we put the registration request
		// into this array and register it as soon as socket.io is configured.
		_absyncProvider.__registerLater = [];

		// The collections that absync provides.
		_absyncProvider.__collections = {};
	}

	/**
	 * Register the configurator on the provider itself to allow early configuration during setup phase.
	 * It is recommended to configure absync within a configuration phase of a module.
	 * @param {io.Socket|Function|Object} configuration The socket.io instance to use.
	 * Can also be a constructor for a socket.
	 * Can also be an object with a "socket" member that provides either of the above.
	 */
	AbsyncProvider.configure = function AbsyncProvider$configure( configuration ) {
		var _absyncProvider = this;

		// If the configuration has a "socket" member, unpack it.
		//noinspection JSUnresolvedVariable
		var socket = configuration.socket || configuration;
		// Determine if the socket is an io.Socket.
		//noinspection JSUnresolvedVariable
		var isSocket = io && io.Socket && socket instanceof io.Socket;

		if( typeof socket == "function" ) {
			// Expect the passed socket to be a constructor.
			_absyncProvider.__ioSocket = socket();

		} else if( isSocket ) {
			// Expect the passed socket to be an io.Socket instance.
			_absyncProvider.__ioSocket = socket;

		} else {
			throw new Error( "configure() expects input to be a function or a socket.io Socket instance." );
		}

		// Check if services already tried to register listeners, if so, register them now.
		// This can happen when a service was constructed before absync was configured.
		if( _absyncProvider.__registerLater.length ) {
			angular.forEach( _absyncProvider.__registerLater, function registerListener( listener ) {
				this.__handleEntityEvent( listener.eventName, listener.callback );
			} );
			_absyncProvider.__registerLater = [];
		}
	};

	//TODO: Remove this noinspection when WebStorm 11 is available.
	//noinspection JSValidateJSDoc
	/**
	 * Request a new synchronized collection.
	 * This only registers the intent to use that collection. It will be constructed when it is first used.
	 * @param {String} name The name of the collection and service name.
	 * @param {AbsyncServiceConfiguration|Object} configuration The configuration for this collection.
	 */
	AbsyncProvider.prototype.collection = function AbsyncProvider$collection( name, configuration ) {
		var _absyncProvider = this;

		// Collection names (and, thus service names) have to be unique.
		// We can't create multiple services with the same name.
		if( _absyncProvider.__collections[ name ] ) {
			throw new Error( "A collection with the name '" + name + "' was already requested. Names for collections must be unique." );
		}

		// Register the service configuration.
		// absyncCacheServiceFactory will return a constructor for a service with the given configuration.
		_absyncProvider.__collections[ name ] = absyncCacheServiceFactory( name, configuration );

		// Register the new service.
		// Yes, we want an Angular "service" here, because we want it constructed with "new".
		_absyncProvider.__provide.service( name, _absyncProvider.__collections[ name ] );
	};

	//noinspection JSUnusedGlobalSymbols
	/**
	 * Register the service factory.
	 * @param {angular.IRootScopeService|Object} $rootScope
	 * @returns {AbsyncService}
	 * @ngInject
	 */
	AbsyncProvider.prototype.$get = function AbsyncProvider$$get( $rootScope ) {
		return new AbsyncService( this, $rootScope );
	};


	/**
	 * The service that is received when injecting "absync".
	 * This service is primarily used internally to set up the connection between socket.io and the individual
	 * caching services.
	 * @param {AbsyncProvider|Object} parentProvider The AbsyncProvider that provides this service.
	 * @constructor
	 */
	function AbsyncService( parentProvider ) {
		this.__absyncProvider = parentProvider;
	}

	/**
	 * Configure the socket.io connection for absync.
	 * This configuration of absync should usually be performed through the absyncProvider in the configuration
	 * phase of a module.
	 * @param {io.Socket|Function|Object} configuration The socket.io instance to use.
	 */
	AbsyncService.prototype.configure = function AbsyncService$configure( configuration ) {
		var _absyncProvider = this.__absyncProvider;
		_absyncProvider.configure( configuration );
	};

	/**
	 * Register an event listener that is called when a specific entity is received on the websocket.
	 * @param {String} eventName The event name, usually the name of the entity.
	 * @param {Function} callback The function to call when the entity is received.
	 * @return {Function|null} If the listener could be registered, it returns a function that, when called, removes
	 * the event listener.
	 * If the listener registration was delayed, null is returned.
	 */
	AbsyncService.prototype.on = function AbsyncService$on( eventName, callback ) {
		var _absyncProvider = this.__absyncProvider;
		var _absyncService = this;

		// If we have no configured socket.io connection yet, remember to register it later.
		if( !_absyncProvider.__ioSocket ) {

			if( _absyncProvider.__registerLater.length > 9999 ) {
				// Be defensive, something is probably not right here.
				return null;
			}

			// TODO: Use promises here, so that we can always return the event listener removal function.
			_absyncProvider.__registerLater.push( {
				eventName : eventName,
				callback  : callback
			} );
			return null;
		}

		return _absyncService.__handleEntityEvent( eventName, callback );
	};

	/**
	 * Register an event listener on the websocket.
	 * @param {String} eventName The event name, usually the name of the entity.
	 * @param {Function} callback The function to call when the entity is received.
	 * @returns {Function}
	 */
	AbsyncService.prototype.__handleEntityEvent = function AbsyncService$__handleEntityEvent( eventName, callback ) {
		var _absyncProvider = this.__absyncProvider;

		// Register the callback with socket.io.
		_absyncProvider.__ioSocket.on( eventName, callback );

		// Return a function that removes the listener.
		return function removeListener() {
			_absyncProvider.__ioSocket.removeListener( eventName, callback );
		};
	};

	/**
	 * Convenience method to allow the user to emit() from the websocket.
	 * This is not utilized in absync internally.
	 * @param {String} eventName
	 * @param {*} data
	 * @param {Function} [callback]
	 */
	AbsyncService.prototype.emit = function AbsyncService$emit( eventName, data, callback ) {
		var _absyncProvider = this.__absyncProvider;

		if( !_absyncProvider.__ioSocket ) {
			throw new Error( "socket.io is not initialized." );
		}

		_absyncProvider.__ioSocket.emit( eventName, data, function afterEmit() {
			if( callback ) {
				callback.apply( _absyncProvider.__ioSocket, arguments );
			}
		} );
	};

	/**
	 * This factory serves as a closure to make the configuration available to the cache service.
	 * @param {String} name The name of the service.
	 * @param {AbsyncServiceConfiguration} configuration The configuration for this service.
	 * @returns {CacheService}
	 */
	function absyncCacheServiceFactory( name, configuration ) {
		// There is no code here, other than the CacheService definition, followed by "return CacheService;"

		/**
		 * This service factory is the core of absync.
		 * It returns a CacheService instance that is specialized to the given configuration.
		 * This service will handle keep the stored collection in sync.
		 * @returns {CacheService}
		 * @ngInject
		 */
		function CacheService( $http, $injector, $log, $q, $rootScope, absync ) {
			var _cacheService = this;
			$log.info( "absync service '" + name + "' was instantiated." );

			// Retrieve a reference to the model of the collection that is being cached.
			var _injector = configuration.injector || $injector;
			var _injectorHasModel = _injector.has( configuration.model );
			if( !_injectorHasModel ) {
				throw new Error( "Unable to construct the '" + name + "' service, because the referenced model '" + configuration.model + "' is not available for injection." );
			}
			var _model = (typeof configuration.model === "string" ) ? _injector.get( configuration.model ) : configuration.model;

			// Retrieve the serialization methods.
			var serializeModel = _model.serialize || configuration.serialize || serializationNoop;
			var deserializeModel = _model.deserialize || configuration.deserialize || serializationNoop;

			// Store configuration.
			_cacheService.name = name;
			_cacheService.configuration = configuration;

			// The entity cache must be constructed as an empty array, to allow the user to place watchers on it.
			// We must never replace the cache with a new array, we must always manipulate the existing one.
			// Otherwise watchers will not behave as the user expects them to.
			/* @type {Array<configuration.model>} */
			_cacheService.entityCache = [];
			// The raw cache is data that hasn't been deserialized and is used internally.
			_cacheService.__entityCacheRaw = null;

			// TODO: Using deferreds is an anti-pattern and probably provides no value here.
			_cacheService.__dataAvailableDeferred = $q.defer();
			_cacheService.__objectsAvailableDeferred = $q.defer();
			// A promise that is resolved once initial data synchronization has taken place.
			_cacheService.dataAvailable = _cacheService.__dataAvailableDeferred.promise;
			// A promise that is resolved once the received data is extended to models.
			_cacheService.objectsAvailable = _cacheService.__objectsAvailableDeferred.promise;

			// Use $http by default and expose it on the service.
			// This allows the user to set a different, possibly decorated, HTTP interface for this service.
			_cacheService.httpInterface = $http;
			// Do the same for our logger.
			_cacheService.logInterface = $log;
			// The scope on which we broadcast all our relevant events.
			_cacheService.scope = $rootScope;
			// Keep a reference to $q.
			_cacheService.q = $q;

			// Prefix log messages with this string.
			_cacheService.logPrefix = "absync:" + name.toLocaleUpperCase() + " ";

			// If enabled, entities received in response to a create or update API call, will be put into the cache.
			// Otherwise, absync will wait for them to be published through the websocket channel.
			_cacheService.forceEarlyCacheUpdate = false;

			// Expose the serializer/deserializer so that they can be adjusted at any time.
			_cacheService.serializer = serializeModel;
			_cacheService.deserializer = deserializeModel;

			// Tell absync to register an event listener for both our entity and its collection.
			// When we receive these events, we broadcast an equal Angular event on the root scope.
			// This way the user can already peek at the data (manipulating it is discouraged though).
			absync.on( configuration.entityName, _cacheService.__onEntityOnWebsocket.bind( _cacheService ) );
			absync.on( configuration.collectionName, _cacheService.__onCollectionOnWebsocket.bind( _cacheService ) );

			// Now we listen on the root scope for the same events we're firing above.
			// This is where our own absync synchronization logic kicks in.
			$rootScope.$on( configuration.entityName, _cacheService.__onEntityReceived.bind( _cacheService ) );
			$rootScope.$on( configuration.collectionName, _cacheService.__onCollectionReceived.bind( _cacheService ) );

			// Wait for data to be available.
			_cacheService.dataAvailable
				.then( _cacheService.__onDataAvailable.bind( _cacheService ) );
		}

		/**
		 * Invoked when an entity is received on a websocket.
		 * Translates the websocket event to an Angular event and broadcasts it on the scope.
		 * @param {Object} message
		 * @private
		 */
		CacheService.prototype.__onEntityOnWebsocket = function CacheService$__onEntityOnWebsocket( message ) {
			var _cacheService = this;
			_cacheService.scope.$broadcast( configuration.entityName, message[ configuration.entityName ] );
		};

		/**
		 * Invoked when a collection is received on a websocket.
		 * Translates the websocket event to an Angular event and broadcasts it on the scope.
		 * @param {Object} message
		 * @private
		 */
		CacheService.prototype.__onCollectionOnWebsocket = function CacheService$__onCollectionOnWebsocket( message ) {
			var _cacheService = this;
			_cacheService.scope.$broadcast( configuration.collectionName, message[ configuration.collectionName ] );
		};

		/**
		 * Event handler for when the initial badge of raw data becomes available.
		 * @param {Array<Object>} rawData
		 * @private
		 */
		CacheService.prototype.__onDataAvailable = function CacheService$__onDataAvailable( rawData ) {
			var _cacheService = this;

			// _cacheService.entityCache is expected to be an empty array.
			// We initialize it in the constructor to an empty array and we don't expect any writes to have
			// happened to it. In case writes *did* happen, we assume that whoever wrote to it knows what
			// they're doing.
			rawData[ configuration.collectionName ].forEach( deserializeCollectionEntry );

			// Resolve out "objects are available" deferred.
			// TODO: We could just as well initialize objectAvailable to the return value of this call block.
			_cacheService.__objectsAvailableDeferred.resolve( _cacheService.entityCache );

			// Notify the rest of the application about a fresh collection.
			_cacheService.scope.$broadcast( "collectionNew", {
				service : _cacheService,
				cache   : _cacheService.entityCache
			} );

			function deserializeCollectionEntry( rawEntity ) {
				_cacheService.entityCache.push( _cacheService.deserializer( rawEntity ) );
			}
		};

		/**
		 * Event handler for when an entity is received on the root scope.
		 * @param {Object} event The event object.
		 * @param {Object} args The raw object as it was read from the wire.
		 * @private
		 */
		CacheService.prototype.__onEntityReceived = function CacheService$__onEntityReceived( event, args ) {
			var _cacheService = this;
			var _entityReceived = args;

			// Determine if the received record consists ONLY of an id property,
			// which would mean that this record was deleted from the backend.
			if( 1 === Object.keys( _entityReceived ).length && _entityReceived.hasOwnProperty( "id" ) ) {
				_cacheService.logInterface.info( _cacheService.logPrefix + "Entity was deleted from the server. Updating cache…" );
				_cacheService.__removeEntityFromCache( _entityReceived.id );

			} else {
				_cacheService.logInterface.debug( _cacheService.logPrefix + "Entity was updated on the server. Updating cache…" );
				_cacheService.__updateCacheWithEntity( _cacheService.deserializer( _entityReceived ) );
			}
		};

		/**
		 * Event handler for when a collection is received on the root scope.
		 * @param {Object} event The event object.
		 * @param {Array<Object>} args The raw collection as it was read from the wire.
		 * @private
		 */
		CacheService.prototype.__onCollectionReceived = function CacheService$__onCollectionReceived( event, args ) {
			var _cacheService = this;
			var _collectionReceived = args;

			// When we're receiving a full collection, all data we currently have in our cache is useless.
			// We reset the length of the array here, because assigning a new array would possibly conflict
			// with watchers placed on the original object.
			while( 0 < _cacheService.entityCache.length ) {
				_cacheService.entityCache.length = 0;
			}

			// Deserialize the received data and place the models in our cache.
			_collectionReceived.forEach( addEntityToCache );

			function addEntityToCache( entityReceived ) {
				var deserialized = _cacheService.deserializer( entityReceived );
				_cacheService.__updateCacheWithEntity( deserialized );
			}
		};

		/**
		 * Ensure that the cached collection is retrieved from the server.
		 * @param {Boolean} [forceReload=false] Should the data be loaded, even if the service already has a local cache?
		 * @returns {Promise<Array<configuration.model>>}
		 */
		CacheService.prototype.ensureLoaded = function CacheService$ensureLoaded( forceReload ) {
			var _cacheService = this;

			forceReload = (forceReload === true);

			// We only perform any loading, if we don't have raw data cached yet, or if we're forced.
			if( null === _cacheService.__entityCacheRaw || forceReload ) {
				_cacheService.__entityCacheRaw = [];

				// If the user did not provide information necessary to work with a collection, immediately return
				// a promise for an empty collection. The user could still use read() to grab individual entities.
				if( !configuration.collectionName || !configuration.collectionUri ) {
					return _cacheService.q.when( [] );
				}

				_cacheService.logInterface.info( _cacheService.logPrefix + "Retrieving '" + configuration.collectionName + "' collection…" );
				_cacheService.httpInterface
					.get( configuration.collectionUri )
					.then( onCollectionReceived, onCollectionRetrievalFailure );
			}

			// Return a promise that is resolved once the data was read and converted to models.
			// When the promise is resolved, it will return a reference to the entity cache.
			return _cacheService.q.all(
				[
					_cacheService.dataAvailable,
					_cacheService.objectsAvailable
				] )
				.then( function dataAvailable() {
					return _cacheService.entityCache;
				} );

			/**
			 * Invoked when the collection was received from the server.
			 * @param {Object} serverResponse The reply sent from the server.
			 */
			function onCollectionReceived( serverResponse ) {
				if( !serverResponse.data[ configuration.collectionName ] ) {
					throw new Error( "The response from the server was not in the expected format. It should have a member named '" + configuration.collectionName + "'." );
				}

				_cacheService.__entityCacheRaw = serverResponse.data;
				_cacheService.__dataAvailableDeferred.resolve( serverResponse.data );
			}

			/**
			 * Invoked when there was an error while trying to retrieve the collection from the server.
			 * @param {Error} error
			 */
			function onCollectionRetrievalFailure( error ) {
				_cacheService.logInterface.error( _cacheService.logPrefix + "Unable to retrieve the collection from the server.", error );
				_cacheService.__entityCacheRaw = null;
				_cacheService.scope.$emit( "absyncError", error );
			}
		};

		/**
		 * Read a single entity from the cache, or load it from the server if required.
		 * The entity will be placed into the cache.
		 * @param {String} id The ID of the entity to retrieve.
		 * @param {Boolean} [forceReload=false] Should the entity be retrieved from the server, even if it is already in the cache?
		 * @returns {Promise<configuration.model>}
		 */
		CacheService.prototype.read = function CacheService$read( id, forceReload ) {
			var _cacheService = this;

			forceReload = (forceReload === true);

			if( !forceReload ) {
				// Check if the entity is in the cache and return instantly if found.
				for( var entityIndex = 0, entity = _cacheService.entityCache[ 0 ];
				     entityIndex < _cacheService.entityCache.length;
				     ++entityIndex, entity = _cacheService.entityCache[ entityIndex ] ) {
					if( entity.id === id ) {
						return _cacheService.q.when( entity );
					}
				}
			}

			// Grab the entity from the backend.
			return _cacheService.httpInterface
				.get( configuration.entityUri + "/" + id )
				.then( onEntityRetrieved, onEntityRetrievalFailure );

			/**
			 * Invoked when the entity was retrieved from the server.
			 * @param {Object} serverResponse The reply sent from the server.
			 */
			function onEntityRetrieved( serverResponse ) {
				if( !serverResponse.data[ configuration.entityName ] ) {
					throw new Error( "The response from the server was not in the expected format. It should have a member named '" + configuration.entityName + "'." );
				}

				// Deserialize the object and place it into the cache.
				// We do not need to check here if the object already exists in the cache.
				// While it could be possible that the same entity is retrieved multiple times, __updateCacheWithEntity
				// will not insert duplicated into the cache.
				var deserialized = _cacheService.deserializer( serverResponse.data[ configuration.entityName ] );
				_cacheService.__updateCacheWithEntity( deserialized );
				return deserialized;
			}

			/**
			 * Invoked when there was an error while trying to retrieve the entity from the server.
			 * @param {Error} error
			 */
			function onEntityRetrievalFailure( error ) {
				_cacheService.logInterface.error( _cacheService.logPrefix + "Unable to retrieve entity with ID '" + id + "' from the server.", error );
				_cacheService.scope.$emit( "absyncError", error );
			}
		};

		/**
		 * Updates an entity and persists it to the backend and the cache.
		 * @param {configuration.model} entity
		 * @return {Promise<configuration.model>} A promise that will be resolved with the updated entity.
		 */
		CacheService.prototype.update = function CacheService$update( entity ) {
			var _cacheService = this;

			// First create a copy of the object, which has complex properties reduced to their respective IDs.
			var reduced = _cacheService.reduceComplex( entity );
			// Now serialize the object.
			var serialized = _cacheService.serializer( reduced );

			// Wrap the entity in a new object, with a single property, named after the entity type.
			var wrappedEntity = {};
			wrappedEntity[ configuration.entityName ] = serialized;

			// Check if the entity has an "id" property, if it has, we will update. Otherwise, we create.
			if( "undefined" !== typeof( entity.id ) ) {
				return _cacheService.httpInterface
					.put( configuration.entityUri + "/" + entity.id, wrappedEntity )
					.then( afterEntityStored, onEntityStorageFailure );

			} else {
				// Create a new entity
				return _cacheService.httpInterface
					.post( configuration.collectionUri, wrappedEntity )
					.then( afterEntityStored, onEntityStorageFailure );
			}

			/**
			 * Invoked when the entity was stored on the server.
			 * @param {Object} serverResponse The reply sent from the server.
			 */
			function afterEntityStored( serverResponse ) {
				// Writing an entity to the backend will usually invoke an update event to be
				// broadcast over websockets, where we would also retrieve the updated record.
				// We still put the updated record we receive here into the cache to ensure early consistency.
				// TODO: This might actually not be optimal. Consider only handling the websocket update.
				if( serverResponse.data[ configuration.entityName ] ) {
					var newEntity = _cacheService.deserializer( serverResponse.data[ configuration.entityName ] );

					// If early cache updates are forced, put the return entity into the cache.
					if( _cacheService.forceEarlyCacheUpdate ) {
						_cacheService.__updateCacheWithEntity( newEntity );
					}
					return newEntity;
				}
				throw new Error( "The response from the server was not in the expected format. It should have a member named '" + configuration.entityName + "'." );
			}

			function onEntityStorageFailure( error ) {
				_cacheService.logInterface.error( _cacheService.logPrefix + "Unable to store entity on the server.", error );
				_cacheService.logInterface.error( error );
			}
		};

		/**
		 * Creates a new entity and persists it to the backend and the cache.
		 */
		CacheService.prototype.create = CacheService.prototype.update;

		/**
		 * Remove an entity from the cache and have it deleted on the backend.
		 * @param {Object} entity
		 */
		CacheService.prototype.delete = function CacheService$delete( entity ) {
			var _cacheService = this;

			var entityId = entity.id;
			return _cacheService.httpInterface
				.delete( configuration.entityUri + "/" + entityId )
				.success( onEntityDeleted )
				.error( onEntityDeletionFailed );

			function onEntityDeleted() {
				return _cacheService.__removeEntityFromCache( entityId );
			}

			function onEntityDeletionFailed( data, status, headers, config ) {
				_cacheService.logInterface.error( data );
				throw new Error( "Unable to delete entity." );
			}
		};

		/**
		 * Put an entity into the cache or update the existing record if the entity was already in the cache.
		 * @param {Object} entityToCache
		 * @private
		 */
		CacheService.prototype.__updateCacheWithEntity = function CacheService$__updateCacheWithEntity( entityToCache ) {
			var _cacheService = this;

			_cacheService.logInterface.info( _cacheService.logPrefix + "Updating entity in cache…" );

			var found = false;
			for( var entityIndex = 0, entity = _cacheService.entityCache[ 0 ];
			     entityIndex < _cacheService.entityCache.length;
			     ++entityIndex, entity = _cacheService.entityCache[ entityIndex ] ) {
				if( entity.id == entityToCache.id ) {
					// Allow the user to intervene in the update process, before updating the entity.
					_cacheService.scope.$broadcast( "beforeEntityUpdated",
						{
							service : _cacheService,
							cache   : _cacheService.entityCache,
							entity  : _cacheService.entityCache[ entityIndex ],
							updated : entityToCache
						} );

					// Use the "copyFrom" method on the entity, if it exists, otherwise use naive approach.
					var targetEntity = _cacheService.entityCache[ entityIndex ];
					if( typeof targetEntity.copyFrom === "function" ) {
						targetEntity.copyFrom( entityToCache );

					} else {
						angular.extend( targetEntity, entityToCache );
					}

					found = true;

					// After updating the entity, send another event to allow the user to react.
					_cacheService.scope.$broadcast( "entityUpdated",
						{
							service : _cacheService,
							cache   : _cacheService.entityCache,
							entity  : _cacheService.entityCache[ entityIndex ]
						} );
					break;
				}
			}

			// If the entity wasn't found in our records, it's a new entity.
			if( !found ) {
				_cacheService.entityCache.push( entityToCache );
				_cacheService.scope.$broadcast( "entityNew", {
					service : _cacheService,
					cache   : _cacheService.entityCache,
					entity  : entityToCache
				} );
			}
		};

		/**
		 * Removes an entity from the internal cache. The entity is not removed from the backend.
		 * @param {String} id The ID of the entity to remove from the cache.
		 * @private
		 */
		CacheService.prototype.__removeEntityFromCache = function CacheService$__removeEntityFromCache( id ) {
			var _cacheService = this;

			for( var entityIndex = 0, entity = _cacheService.entityCache[ 0 ];
			     entityIndex < _cacheService.entityCache.length;
			     ++entityIndex, entity = _cacheService.entityCache[ entityIndex ] ) {
				if( entity.id == id ) {
					// Before removing the entity, allow the user to react.
					_cacheService.scope.$broadcast( "beforeEntityRemoved", {
						service : _cacheService,
						cache   : _cacheService.entityCache,
						entity  : entity
					} );

					// Remove the entity from the cache.
					_cacheService.entityCache.splice( entityIndex, 1 );

					// Send another event to allow the user to take note of the removal.
					_cacheService.scope.$broadcast( "entityRemoved", {
						service : _cacheService,
						cache   : _cacheService.entityCache,
						entity  : entity
					} );
					break;
				}
			}
		};

		/**
		 * Retrieve an associative array of all cached entities, which uses the ID of the entity records as the key in the array.
		 * This is a convenience method that is not utilized internally.
		 * @returns {Array<configuration.model>}
		 */
		CacheService.prototype.lookupTableById = function CacheService$lookupTableById() {
			var _cacheService = this;

			//TODO: Keep a copy of the lookup table and only update it when the cached data updates
			var lookupTable = [];
			for( var entityIndex = 0;
			     entityIndex < _cacheService.entityCache.length;
			     ++entityIndex ) {
				lookupTable[ _cacheService.entityCache[ entityIndex ].id ] = _cacheService.entityCache[ entityIndex ];
			}
			return lookupTable;
		};

		/**
		 * Reduce instances of complex types within an entity with their respective IDs.
		 * Note that no type checks are being performed. Every nested object with an "id" property is treated as a complex type.
		 * @param {Object} entity The entity that should have its complex member reduced.
		 * @param {Boolean} [arrayInsteadOfObject=false] true if the manipulated entity is an array; false if it's an object.
		 * @returns {Object|Array} A copy of the input entity, with complex type instances replaced with their respective ID.
		 */
		CacheService.prototype.reduceComplex = function CacheService$reduceComplex( entity, arrayInsteadOfObject ) {
			var _cacheService = this;

			var result = arrayInsteadOfObject ? [] : {};
			for( var propertyName in entity ) {
				if( !entity.hasOwnProperty( propertyName ) ) {
					continue;
				}

				// Recurse for nested arrays.
				if( Array.isArray( entity[ propertyName ] ) ) {
					result[ propertyName ] = _cacheService.reduceComplex( entity[ propertyName ], true );
					continue;
				}

				// Replace complex type with its ID.
				if( entity[ propertyName ] && entity[ propertyName ].id ) {
					result[ propertyName ] = entity[ propertyName ].id;
					continue;
				}

				// Just copy over the plain property.
				result[ propertyName ] = entity[ propertyName ];
			}
			return result;
		};

		/**
		 * Populate references to complex types in an instance.
		 * @param {Object} entity The entity that should be manipulated.
		 * @param {String} propertyName The name of the property of entity which should be populated.
		 * @param {CacheService} cache An instance of another caching service that can provide the complex
		 * type instances which are being referenced in entity.
		 * @param {Boolean} [force=false] If true, all complex types will be replaced with references to the
		 * instances in cache; otherwise, only properties that are string representations of complex type IDs will be replaced.
		 * @returns {Promise}
		 */
		CacheService.prototype.populateComplex = function CacheService$populateComplex( entity, propertyName, cache, force ) {
			var _cacheService = this;

			// If the target property is an array, ...
			if( Array.isArray( entity[ propertyName ] ) ) {
				// ...map the elements in the array to promises.
				var promises = entity[ propertyName ].map( mapElementToPromise );

				return _cacheService.q.all( promises );

			} else {
				// We usually assume the properties to be strings (the ID of the referenced complex).
				if( typeof entity[ propertyName ] !== "string" ) {
					// If "force" is enabled, we check if this non-string property is an object and has an "id" member, which is a string.
					if( force && typeof entity[ propertyName ] === "object" && typeof entity[ propertyName ].id === "string" ) {
						// If that is true, then we replace the whole object with the ID and continue as usual.
						entity[ propertyName ] = entity[ propertyName ].id;

					} else {
						return _cacheService.q.when( false );
					}
				}

				// Treat the property as an ID and read the complex with that ID from the cache.
				return cache.read( entity[ propertyName ] )
					.then( onComplexRetrieved );
			}

			function mapElementToPromise( element, index ) {
				// We usually assume the properties to be strings (the ID of the referenced complex).
				if( typeof entity[ propertyName ][ index ] !== "string" ) {
					// If "force" is enabled, we check if this non-string property is an object and has an "id" member, which is a string.
					if( force && typeof entity[ propertyName ][ index ] === "object" && typeof entity[ propertyName ][ index ].id === "string" ) {
						// If that is true, then we replace the whole object with the ID and continue as usual.
						entity[ propertyName ][ index ] = entity[ propertyName ][ index ].id;

					} else {
						return _cacheService.q.when( false );
					}
				}

				// Treat the property as an ID and read the complex with that ID from the cache.
				return cache.read( entity[ propertyName ][ index ] )
					.then( onComplexRetrieved );

				function onComplexRetrieved( complex ) {
					// When the complex was retrieved, store it back into the array.
					entity[ propertyName ][ index ] = complex;
				}
			}

			function onComplexRetrieved( complex ) {
				// When the complex was retrieved, store it back into the entity.
				entity[ propertyName ] = complex;
			}
		};

		return CacheService;
	}

	function serializationNoop( model ) {
		return model;
	}

}());
