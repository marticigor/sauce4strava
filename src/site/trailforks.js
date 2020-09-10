/* global sauce  */

sauce.ns('trailforks', ns => {
    'use strict';

    const tfCache = new sauce.cache.TTLCache('trailforks', 12 * 3600 * 1000);

    const difficulties = {
        1: {
            title: 'Access Road/Trail',
            icon: 'road-duotone',
            class: 'road'
        },
        2: {
            title: 'Easiest / White Circle',
            image: 'white-150x150.png'
        },
        3: {
            title: 'Easy / Green Circle',
            image: 'green-150x150.png'
        },
        4: {
            title: 'Intermediate / Blue Square',
            image: 'blue-150x150.png'
        },
        5: {
            title: 'Very Difficult / Black Diamond',
            image: 'black-150x150.png'
        },
        6: {
            title: 'Extremely Difficult / Double Black Diamond',
            image: 'double-black-150x150.png'
        },
        7: {
            title: 'Secondary Access Road/Trail',
            icon: 'road-duotone',
            class: 'road'
        },
        8: {
            title: 'Extremely Dangerous / Pros Only',
            image: 'pro-only-150x150.png'
        },
        11: {
            title: 'Advanced: Grade 4',
            image: 'black-150x150.png'
        },
    };

    const conditions = {
        // 0 = Unknown
        1: {
            title: "Snow Packed",
            class: "snow",
            icon: 'icicles-duotone'
        },
        2: {
            title: "Prevalent Mud",
            class: "mud",
            icon: 'water-duotone'
        },
        3: {
            title: "Wet",
            class: "wet",
            icon: 'umbrella-duotone'
        },
        // 4 = Variable
        5: {
            title: "Dry",
            class: "dry",
            icon: 'heat-duotone'
        },
        6: {
            title: "Very Dry",
            class: "very-dry",
            icon: 'temperature-hot-duotone'
        },
        7: {
            title: "Snow Covered",
            class: "snow",
            icon: 'snowflake-duotone'
        },
        8: {
            title: "Freeze/thaw Cycle",
            class: "icy",
            icon: 'icicles-duotone'
        },
        9: {
            title: "Icy",
            class: "icy",
            icon: 'icicles-duotone'
        },
        10: {
            title: "Snow Groomed",
            class: "snow",
            icon: 'snowflake-duotone'
        },
        11: {
            title: "Ideal",
            class: "ideal",
            icon: 'thumbs-up-duotone'
        },
    };

    const statuses = {
        // 1: {title: "All Clear", class: "clear"},
        2: {
            title: "Minor Issue",
            class: "minor-issue"
        },
        3: {
            title: "Significant Issue",
            class: "significant-issue"
        },
        4: {
            title: "Closed",
            class: "closed"
        },
    };


    function lookupEnums(trail) {
        if (!trail) {
            return trail;
        }
        return Object.assign({
            statusInfo: statuses[trail.status],
            conditionInfo: conditions[trail.condition],
            difficultyInfo: difficulties[trail.difficulty],
        }, trail);
    }


    async function fetchTrailsUnofficial(bbox) {
        const tfHost = 'https://d35dnzkynq0s8c.cloudfront.net';
        const bboxKey = `bbox-${JSON.stringify(bbox)}`;
        let data = await tfCache.get(bboxKey);
        if (!data) {
            const q = new URLSearchParams();
            q.set('rmsP', 'j2');
            q.set('mod', 'trailforks');
            q.set('op', 'tracks');
            q.set('format', 'geojson');
            q.set('z', '100');  // nearly zero impact, but must be roughly over 10
            q.set('layers', 'tracks'); // comma delim (markers,tracks,polygons)
            q.set('bboxa', [bbox.swc[1], bbox.swc[0], bbox.nec[1], bbox.nec[0]].join(','));
            const resp = await fetch(`${tfHost}/rms/?${q.toString()}`);
            data = await resp.json();
            if (data.rmsS === false) {
                throw new Error(`TF API Error: ${data.rmsM}`);
            }
            await tfCache.set(bboxKey, data);
        }
        const trailQ = new URLSearchParams();
        trailQ.set('scope', 'full');
        trailQ.set('api_key', tfApiKey());
        const trails = data.features.filter(x => x.type === 'Feature' && x.properties.type === 'trail');
        // In leu of having a working trails API, do it manually..
        return await Promise.all(trails.map(async x => { 
            const trailKey = `trail-${x.id}`;
            let data = await tfCache.get(trailKey);
            if (!data) {
                trailQ.set('id', x.id);
                const resp = await fetch(`${tfHost}/api/1/trail/?${trailQ.toString()}`);
                data = await resp.json();
                if (data.error !== 0) {
                    throw new Error(`TF API Error: ${data.error} ${data.message}`);
                }
                await tfCache.set(trailKey, data);
            }
            return lookupEnums(data.data);
        }));
        /*return data.features.filter(x => x.type === 'Feature' && x.properties.type === 'trail').map(x => {
            // Make data look more like the official api
            return Object.assign({}, x.properties, {
                title: x.properties.name,
                track: {
                    encodedPath: x.geometry.encodedpath
                }
            });
        });*/
    }


    function tfApiKey() {
        return 'cats'.split('').map((_, i) =>
            String.fromCharCode(1685021555 >> i * 8 & 0xff)).reverse().join('');
    }


    /*
    async function fetchTrails(bbox) {
        //const tfHost = 'https://www.trailforks.com';
        const tfHost = 'https://d35dnzkynq0s8c.cloudfront.net';
        const q = new URLSearchParams();
        q.set('api_key', tfApiKey());
        q.set('rows', '100');
        q.set('scope', 'full');
        q.set('filter', `bbox::${[bbox.swc[0], bbox.swc[1], bbox.nec[0], bbox.nec[1]].join(',')}`);
        const trails = [];
        let page = 1;
        for (;;) {
            q.set('page', page++);
            const resp = await fetch(`${tfHost}/api/1/trails?${q.toString()}`);
            const data = await resp.json();
            if (data.error !== 0) {
                throw new Error(`TF API Error: ${data.error} ${data.message}`);
            }
            if (data.data && data.data.length) {
                for (const x of data.data) {
                    trails.push(lookupEnums(x));
                }
            } else {
                break;
            }
        }
        return trails;
    }
    */


    ns.intersections = async function(latlngStream, distStream) {
        const hashData = new Float32Array([].concat(
            latlngStream.map(x => x[0]),
            latlngStream.map(x => x[1]),
            distStream));
        const argsHash = await sauce.digest('SHA-1', hashData);
        const cacheKey = `intersections-${argsHash}`;
        const cacheHit = await tfCache.get(cacheKey);
        if (cacheHit) {
            return cacheHit;
        }
        const bbox = sauce.geo.boundingBox(latlngStream, {pad: 50});
        const trails = await fetchTrailsUnofficial(bbox);
        //const trails = await fetchTrails(bbox);
        const trailIntersectMatrix = [];
        for (const trail of trails) {
            const lats = trail.track.latitude.split(',');
            const lngs = trail.track.longitude.split(',');
            const path = lats.map((x, i) => [Number(x), Number(lngs[i])]);
            const trailBBox = sauce.geo.boundingBox(path, {pad: 20});
            if (!sauce.geo.boundsOverlap(trailBBox, bbox)) {
                continue;
            }
            const minMatchDistance = 15;
            const matches = [];
            let pathOffsetHint;
            let streamPathMap;
            let streamStartOffset;
            const endMatch = streamEnd => {
                matches.push({streamStart: streamStartOffset, streamEnd, streamPathMap});
                streamStartOffset = null;
                streamPathMap = null;
            };
            for (let i = 0; i < latlngStream.length; i++) {
                const [lat, lng] = latlngStream[i];
                if (!sauce.geo.inBounds([lat, lng], trailBBox)) {
                    if (streamStartOffset != null) {
                        endMatch(i - 1);
                    }
                    continue;
                }
                const [distance, pathOffset] = (new sauce.geo.BDCC(lat, lng)).distanceToPolyline(path, {
                    min: minMatchDistance,
                    offsetHint: pathOffsetHint
                });
                pathOffsetHint = pathOffset;
                if (distance <= minMatchDistance) {
                    if (streamStartOffset == null) {
                        streamStartOffset = i;
                        streamPathMap = {};
                    }
                    streamPathMap[i] = pathOffset;
                } else {
                    if (streamStartOffset != null) {
                        endMatch(i - 1);
                    }
                    if (distance > minMatchDistance * 10) {
                        // Optimization..
                        // Scan fwd till we are at least potentially near the trail.
                        const offt = distStream[i];
                        const maxSkipDistance = distance * 0.80 - minMatchDistance;
                        while (i < latlngStream.length - 1) {
                            const covered = distStream[i + 1] - offt;
                            if (covered < maxSkipDistance) {
                                i++;
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
            if (streamStartOffset != null) {
                endMatch(latlngStream.length - 1);
            }
            if (matches.length) {
                trailIntersectMatrix.push({
                    path,
                    trail,
                    matches
                });
            }
        }
        await tfCache.set(cacheKey, trailIntersectMatrix);
        return trailIntersectMatrix;
    };
});
