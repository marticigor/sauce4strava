/* global sauce, browser */

import * as queues from '/src/common/jscoop/queues.js';
import * as futures from '/src/common/jscoop/futures.js';
import * as locks from '/src/common/jscoop/locks.js';

const actsStore = new sauce.hist.db.ActivitiesStore();
const streamsStore = new sauce.hist.db.StreamsStore();


async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}


async function getActivitiesStreams(activities, streams) {
    const streamKeys = [];
    const actStreams = new Map();
    for (const a of activities) {
        for (const stream of streams) {
            streamKeys.push([a.pk, stream]);
        }
        actStreams.set(a.pk, {});
    }
    for (const x of await streamsStore.getMany(streamKeys)) {
        if (x) {
            actStreams.get(x.activity)[x.stream] = x.data;
        }
    }
    return actStreams;
}


class WorkerPoolExecutor {
    constructor(url, options={}) {
        this.url = url;
        this.maxWorkers = options.maxWorkers || (navigator.hardwareConcurrency || 4);
        this._idle = new queues.Queue();
        this._busy = new Set();
        this._id = 0;
    }

    async _getWorker() {
        let worker;
        if (!this._idle.size) {
            if (this._busy.size >= this.maxWorkers) {
                worker = await this._idle.get();
            } else {
                worker = new Worker(this.url);
            }
        } else {
            worker = await this._idle.get();
        }
        if (worker.dead) {
            return await this._getWorker();
        }
        if (worker.gcTimeout) {
            clearTimeout(worker.gcTimeout);
        }
        this._busy.add(worker);
        return worker;
    }

    async exec(call, ...args) {
        const id = this._id++;
        const f = new futures.Future();
        const onMessage = ev => {
            if (!ev.data || ev.data.id == null) {
                f.setError(new Error("Invalid Worker Message"));
            } else if (ev.data.id !== id) {
                console.warn('Ignoring worker message from other job');
                return;
            } else {
                if (ev.data.success) {
                    f.setResult(ev.data.value);
                } else {
                    f.setError(new Error(ev.data.value));
                }
            }
        };
        const worker = await this._getWorker();
        worker.addEventListener('message', onMessage);
        try {
            worker.postMessage({call, args, id});
            return await f;
        } finally {
            worker.removeEventListener('message', onMessage);
            this._busy.delete(worker);
            worker.gcTimeout = setTimeout(() => {
                worker.dead = true;
                worker.terminate();
            }, 30000);
            this._idle.putNoWait(worker);
        }
    }
}


let _workerPool;
function getWorkerPool() {
    if (!_workerPool) {
        const extUrl = browser.runtime.getURL('');
        _workerPool = new WorkerPoolExecutor(extUrl + 'src/bg/hist-worker.js');
    }
    return _workerPool;
}


export class OffloadProcessor extends futures.Future {
    constructor({manifest, athlete, cancelEvent}) {
        super();
        this.manifest = manifest;
        this.athlete = athlete;
        this.pending = new Set();
        this._incoming = new queues.PriorityQueue();
        this._finished = new queues.Queue();
        this._flushEvent = new locks.Event();
        this._cancelEvent = cancelEvent;
        this._runProcessor();
    }

    flush() {
        this._flushEvent.set();
    }

    putIncoming(activities) {
        for (const a of activities) {
            this.pending.add(a);
            this._incoming.putNoWait(a, a.get('ts'));
        }
    }

    getBatch(count) {
        const batch = [];
        while (this._finished.size && batch.length < count) {
            const a = this._finished.getNoWait();
            this.pending.delete(a);
            batch.push(a);
        }
        return batch;
    }

    get size() {
        return this._finished.size;
    }

    async wait() {
        return await this._finished.wait();
    }

    putFinished(activities) {
        for (const a of activities) {
            this._finished.putNoWait(a);
        }
    }

    async getIncomingDebounced(options={}) {
        const minWait = options.minWait;
        const maxWait = options.maxWait;
        const maxSize = options.maxSize;
        let deadline = maxWait && Date.now() + maxWait;
        let lastSize;
        while (true) {
            const waiters = [
                this._cancelEvent.wait(),
                this._flushEvent.wait(),
            ];
            if (maxSize) {
                waiters.push(this._incoming.wait({size: maxSize}));
            }
            if (minWait && maxWait) {
                waiters.push(sleep(Math.min(minWait, deadline - Date.now())));
            } else if (minWait) {
                waiters.push(sleep(minWait));
            } else if (maxWait) {
                waiters.push(sleep(maxWait));
            }
            await Promise.race(waiters);
            if (this._cancelEvent.isSet()) {
                return null;
            }
            const size = this._incoming.size;
            if (this._flushEvent.isSet()) {
                if (!size) {
                    return null;
                }
            } else if (size != lastSize && size < maxSize && Date.now() < deadline) {
                lastSize = size;
                continue;
            }
            deadline = maxWait && Date.now() + maxWait;
            if (!size) {
                continue;
            }
            this._flushEvent.clear();
            return this._incoming.getAllNoWait();
        }
    }

    async processor() {
        throw new TypeError("Pure virutal method");
        /* Subclass should keep this alive for the duration of their execution.
         * It is also their job to monitor flushEvent and cancelEvent
         */
    }

    async _runProcessor() {
        try {
            this.setResult(await this.processor());
        } catch(e) {
            this.setError(e);
        }
    }
}


export async function extraStreamsProcessor({manifest, activities, athlete}) {
    const actStreams = await getActivitiesStreams(activities,
        ['time', 'moving', 'cadence', 'watts', 'distance', 'grade_adjusted_distance']);
    const extraStreams = [];
    for (const activity of activities) {
        const streams = actStreams.get(activity.pk);
        if (streams.moving) {
            const isTrainer = activity.get('trainer');
            try {
                const activeStream = sauce.data.createActiveStream(streams, {isTrainer});
                extraStreams.push({
                    activity: activity.pk,
                    athlete: athlete.pk,
                    stream: 'active',
                    data: activeStream
                });
            } catch(e) {
                console.warn("Failed to create active stream for: " + activity, e);
                activity.setSyncError(manifest, e);
            }
        }
        if (activity.get('basetype') === 'run') {
            const gap = streams.grade_adjusted_distance;
            const weight = athlete.getWeightAt(activity.get('ts'));
            if (gap && weight) {
                try {
                    const wattsStream = [0];
                    for (let i = 1; i < gap.length; i++) {
                        const dist = gap[i] - gap[i - 1];
                        const time = streams.time[i] - streams.time[i - 1];
                        const kj = sauce.pace.work(weight, dist);
                        wattsStream.push(kj * 1000 / time);
                    }
                    extraStreams.push({
                        activity: activity.pk,
                        athlete: athlete.pk,
                        stream: 'watts_calc',
                        data: wattsStream
                    });
                } catch(e) {
                    console.warn("Failed to create running watts stream for: " + activity, e);
                    activity.setSyncError(manifest, e);
                }
            }
        }
    }
    await streamsStore.putMany(extraStreams);
}


export async function activityStatsProcessor({manifest, activities, athlete}) {
    const actStreams = await getActivitiesStreams(activities,
        ['time', 'heartrate', 'active', 'watts', 'watts_calc', 'altitude']);
    const hrZones = athlete.get('hrZones');
    const ltHR = hrZones && (hrZones.z4 + hrZones.z3) / 2;
    const maxHR = hrZones && sauce.perf.estimateMaxHR(hrZones);
    for (const activity of activities) {
        const streams = actStreams.get(activity.pk);
        if (!streams.time || !streams.active) {
            continue;
        }
        const ftp = athlete.getFTPAt(activity.get('ts'));
        const stats = {
            activeTime: sauce.data.activeTime(streams.time, streams.active)
        };
        activity.set({stats});
        if (streams.heartrate && hrZones) {
            try {
                const restingHR = ftp ? sauce.perf.estimateRestingHR(ftp) : 60;
                stats.tTss = sauce.perf.tTSS(streams.heartrate, streams.time, streams.active,
                    ltHR, restingHR, maxHR, athlete.get('gender'));
            } catch(e) {
                activity.setSyncError(manifest, e);
                continue;
            }
        }
        if (streams.altitude) {
            stats.altitudeGain = sauce.geo.altitudeChanges(streams.altitude).gain;
        }
        if (streams.watts || (streams.watts_calc && activity.get('basetype') === 'run')) {
            const watts = streams.watts || streams.watts_calc;
            try {
                const corrected = sauce.power.correctedPower(streams.time, watts);
                if (!corrected) {
                    continue;
                }
                stats.kj = corrected.kj();
                stats.power = stats.kj * 1000 / stats.activeTime;
                stats.np = corrected.np();
                stats.xp = corrected.xp();
                if (ftp) {
                    stats.tss = sauce.power.calcTSS(stats.np || stats.power, stats.activeTime, ftp);
                    stats.intensity = (stats.np || stats.power) / ftp;
                }
            } catch(e) {
                activity.setSyncError(manifest, e);
                continue;
            }
        }
        activity.set({stats});
    }
}


export async function peaksProcessor({manifest, activities, athlete}) {
    const s = Date.now();
    const wp = getWorkerPool();
    const activityMap = new Map(activities.map(x => [x.pk, x]));
    const work = [];
    const len = activities.length;
    const maxWorkers = Math.ceil(len / 30);
    const concurrency = Math.min(maxWorkers, navigator.hardwareConcurrency || 6);
    const step = Math.ceil(len / concurrency);
    for (let i = 0; i < len; i += step) {
        const chunk = activities.slice(i, i + step);
        work.push(wp.exec('findPeaks', athlete.data, chunk.map(x => x.data)));
    }
    console.info("Find peaks workers:", work.length, 'workers', step, 'acts / worker');
    for (const errors of await Promise.all(work)) {
        for (const x of errors) {
            const activity = activityMap.get(x.activity);
            activity.setSyncError(manifest, new Error(x.error));
        }
    }
    await Promise.all(work);
    console.warn("find peaks done", Date.now() - s, 'ms', activities.length, 'acts', Math.round((Date.now() - s) / activities.length), 'ms/act');
}


export class TrainingLoadProcessor extends OffloadProcessor {
    constructor(...args) {
        super(...args);
        this.completedWith = new Map();
    }

    async processor() {
        const minWait = 10 * 1000;
        const maxWait = 90 * 1000;
        const maxSize = 50;
        while (true) {
            const batch = await this.getIncomingDebounced({minWait, maxWait, maxSize});
            if (batch === null) {
                return;
            }
            batch.sort((a, b) => a.get('ts') - b.get('ts'));  // oldest -> newest
            await this._process(batch);
            this.putFinished(batch);
        }
    }

    async _process(batch) {
        let oldest = batch[0];
        const activities = new Map();
        const external = new Set();
        let unseen = 0;
        let seen = 0;
        for (const a of batch) {
            activities.set(a.pk, a);
            if (!this.completedWith.has(a.pk)) {
                unseen++;
            } else {
                const priorTSS = this.completedWith.get(a.pk);
                if (a.getTSS() !== priorTSS) {
                    unseen++;
                } else {
                    seen++;
                }
            }
        }
        if (!unseen) {
            console.debug("No training load updates required");
            return batch;
        } else {
            console.info("Updating training loads for:", {seen, unseen});
        }
        console.info("Processing ATL and CTL for", batch.length, 'activities');
        const orderedIds = await actsStore.getAllKeysForAthlete(this.athlete.pk,
            {start: oldest.get('ts')});
        const need = orderedIds.filter(x => !activities.has(x));
        for (const a of await actsStore.getMany(need, {models: true})) {
            activities.set(a.pk, a);
            external.add(a);
        }
        const ordered = orderedIds.map(x => activities.get(x)).filter(x => x);
        let atl = 0;
        let ctl = 0;
        let seed;
        // Rewind until we find a valid seed record from a prior day...
        for await (const a of actsStore.siblings(oldest.pk, {models: true, direction: 'prev'})) {
            if (a.getLocaleDay().getTime() !== oldest.getLocaleDay().getTime()) {
                const tl = a.get('training');
                if (!tl) {
                    oldest = a;
                    ordered.unshift(a);
                    activities.set(a.pk, a);
                    external.add(a);
                    continue;  // Keep searching backwards until we find a valid activity.
                } else {
                    seed = a;
                    atl = tl.atl || 0;
                    ctl = tl.ctl || 0;
                    break;
                }
            } else if (a.pk !== oldest.pk) {
                // Prior activity is same day as oldest in this set, we must lump it in.
                oldest = a;
                ordered.unshift(a);
                activities.set(a.pk, a);
                external.add(a);
            } else {
                throw new TypeError("Internal Error: sibling search produced non sensical result");
            }
        }
        if (seed) {
            // Drain the current training loads based on gap to our first entry
            const zeros = Array.from(sauce.date.dayRange(seed.getLocaleDay(),
                oldest.getLocaleDay())).map(x => 0);
            zeros.pop();  // Exclude seed day.
            if (zeros.length) {
                atl = sauce.perf.calcATL(zeros, atl);
                ctl = sauce.perf.calcCTL(zeros, ctl);
            }
        }
        const future = new Date(Date.now() + 7 * 86400 * 1000);
        let i = 0;
        for (const day of sauce.date.dayRange(oldest.getLocaleDay(), future)) {
            if (i >= ordered.length) {
                break;
            }
            const daily = [];
            let tss = 0;
            while (i < ordered.length && ordered[i].getLocaleDay().getTime() === day.getTime()) {
                const act = ordered[i++];
                daily.push(act);
                const actTSS = act.getTSS();
                tss += actTSS || 0;
                this.completedWith.set(act.pk, actTSS);
            }
            atl = sauce.perf.calcATL([tss], atl);
            ctl = sauce.perf.calcCTL([tss], ctl);
            for (const x of daily) {
                x.set('training', {atl, ctl});
            }
        }
        if (i < ordered.length) {
            throw new Error("Internal Error");
        }
        await actsStore.saveModels(external);
    }
}
