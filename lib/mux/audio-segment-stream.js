'use strict';

var Stream = require('../utils/stream.js');
var mp4 = require('../mp4/mp4-generator.js');
var coneOfSilence = require('../data/silence');
var clock = require('../utils/clock');
var trackInfo = require('./track-decode-info.js');

// constants
var AUDIO_PROPERTIES = [
  'audioobjecttype',
  'channelcount',
  'samplerate',
  'samplingfrequencyindex',
  'samplesize'
];

var ONE_SECOND_IN_TS = 90000; // 90kHz clock

// Helper functions
var
  arrayEquals,
  sumFrameByteLengths;

/**
 * Compare two arrays (even typed) for same-ness
 */
arrayEquals = function(a, b) {
  var
    i;

  if (a.length !== b.length) {
    return false;
  }

  // compare the value of each element in the array
  for (i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
};

/**
 * Sum the `byteLength` properties of the data in each AAC frame
 */
sumFrameByteLengths = function(array) {
  var
    i,
    currentObj,
    sum = 0;

  // sum the byteLength's all each nal unit in the frame
  for (i = 0; i < array.length; i++) {
    currentObj = array[i];
    sum += currentObj.data.byteLength;
  }

  return sum;
};

/**
 * Constructs a single-track, ISO BMFF media segment from AAC data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 */
var AudioSegmentStream = function(track, options) {
  var
    adtsFrames = [],
    sequenceNumber = 0,
    earliestAllowedDts = 0,
    audioAppendStartTs = 0,
    videoBaseMediaDecodeTime = Infinity,
    segmentStartDts = null,
    segmentEndDts = null;

  options = options || {};

  AudioSegmentStream.prototype.init.call(this);

  this.push = function(data) {
    trackInfo.collectDtsInfo(track, data);

    if (track) {
      AUDIO_PROPERTIES.forEach(function(prop) {
        track[prop] = data[prop];
      });
    }

    // buffer audio data until end() is called
    adtsFrames.push(data);
  };

  this.setEarliestDts = function(earliestDts) {
    earliestAllowedDts = earliestDts;
  };

  this.setVideoBaseMediaDecodeTime = function(baseMediaDecodeTime) {
    videoBaseMediaDecodeTime = baseMediaDecodeTime;
  };

  this.setAudioAppendStart = function(timestamp) {
    audioAppendStartTs = timestamp;
  };

  this.flush = function() {
    var
      frames,
      moof,
      mdat,
      boxes,
      byteOffset;

    // return early if no audio data has been observed
    if (adtsFrames.length === 0) {
      this.trigger('done', 'AudioSegmentStream');
      return;
    }

    frames = this.trimAdtsFramesByEarliestDts_(adtsFrames);
    track.baseMediaDecodeTime = trackInfo.calculateTrackBaseMediaDecodeTime(
      track, options.keepOriginalTimestamps);

    // this.prefixWithSilence_(track, frames);

    // we have to build the index from byte locations to
    // samples (that is, adts frames) in the audio data
    track.samples = this.generateSampleTable_(frames);

    // concatenate the audio data to constuct the mdat
    mdat = mp4.mdat(this.concatenateFrameData_(frames));

    adtsFrames = [];

    moof = mp4.moof(sequenceNumber, [track]);

    // bump the sequence number for next time
    sequenceNumber++;

    track.initSegment = mp4.initSegment([track]);

    // it would be great to allocate this array up front instead of
    // throwing away hundreds of media segment fragments
    boxes = new Uint8Array(moof.byteLength + mdat.byteLength);

    boxes.set(moof);
    boxes.set(mdat, moof.byteLength);

    trackInfo.clearDtsInfo(track);

    if (segmentStartDts === null) {
      segmentStartDts = frames[0].dts;
      segmentEndDts = segmentStartDts;
    }

    segmentEndDts += frames.length * (ONE_SECOND_IN_TS * 1024 / track.samplerate);

    this.trigger('timingInfo', {
      start: segmentStartDts,
      end: segmentEndDts,
    });

    this.trigger('data', {track: track, boxes: boxes});
    this.trigger('done', 'AudioSegmentStream');
  };

  this.superFlush = function() {
    this.flush();
    trackInfo.clearDtsInfo(track);
    this.trigger('timingInfo', {
      start: segmentStartDts,
      end: segmentEndDts
    });
    segmentStartDts = null;
    segmentEndDts = null;
    this.trigger('superdone', 'AudioSegmentStream');
  }

  this.reset = function() {
    trackInfo.clearDtsInfo(track);
    segmentStartDts = null;
    segmentEndDts = null;
  };

  // Possibly pad (prefix) the audio track with silence if appending this track
  // would lead to the introduction of a gap in the audio buffer
  this.prefixWithSilence_ = function(track, frames) {
    var
      baseMediaDecodeTimeTs,
      frameDuration = 0,
      audioGapDuration = 0,
      audioFillFrameCount = 0,
      audioFillDuration = 0,
      silentFrame,
      i;

    if (!frames.length) {
      return;
    }

    baseMediaDecodeTimeTs = clock.audioTsToVideoTs(track.baseMediaDecodeTime, track.samplerate);
    // determine frame clock duration based on sample rate, round up to avoid overfills
    frameDuration = Math.ceil(ONE_SECOND_IN_TS / (track.samplerate / 1024));

    if (audioAppendStartTs && videoBaseMediaDecodeTime) {
      // insert the shortest possible amount (audio gap or audio to video gap)
      audioGapDuration =
        baseMediaDecodeTimeTs - Math.max(audioAppendStartTs, videoBaseMediaDecodeTime);
      // number of full frames in the audio gap
      audioFillFrameCount = Math.floor(audioGapDuration / frameDuration);
      audioFillDuration = audioFillFrameCount * frameDuration;
    }

    // don't attempt to fill gaps smaller than a single frame or larger
    // than a half second
    if (audioFillFrameCount < 1 || audioFillDuration > ONE_SECOND_IN_TS / 2) {
      return;
    }

    silentFrame = coneOfSilence[track.samplerate];

    if (!silentFrame) {
      // we don't have a silent frame pregenerated for the sample rate, so use a frame
      // from the content instead
      silentFrame = frames[0].data;
    }

    for (i = 0; i < audioFillFrameCount; i++) {
      frames.splice(i, 0, {
        data: silentFrame
      });
    }

    track.baseMediaDecodeTime -=
      Math.floor(clock.videoTsToAudioTs(audioFillDuration, track.samplerate));
  };

  // If the audio segment extends before the earliest allowed dts
  // value, remove AAC frames until starts at or after the earliest
  // allowed DTS so that we don't end up with a negative baseMedia-
  // DecodeTime for the audio track
  this.trimAdtsFramesByEarliestDts_ = function(adtsFrames) {
    if (track.minSegmentDts >= earliestAllowedDts) {
      return adtsFrames;
    }

    // We will need to recalculate the earliest segment Dts
    track.minSegmentDts = Infinity;

    return adtsFrames.filter(function(currentFrame) {
      // If this is an allowed frame, keep it and record it's Dts
      if (currentFrame.dts >= earliestAllowedDts) {
        track.minSegmentDts = Math.min(track.minSegmentDts, currentFrame.dts);
        track.minSegmentPts = track.minSegmentDts;
        return true;
      }
      // Otherwise, discard it
      return false;
    });
  };

  // generate the track's raw mdat data from an array of frames
  this.generateSampleTable_ = function(frames) {
    var
      i,
      currentFrame,
      samples = [];

    for (i = 0; i < frames.length; i++) {
      currentFrame = frames[i];
      samples.push({
        size: currentFrame.data.byteLength,
        duration: 1024 // For AAC audio, all samples contain 1024 samples
      });
    }
    return samples;
  };

  // generate the track's sample table from an array of frames
  this.concatenateFrameData_ = function(frames) {
    var
      i,
      currentFrame,
      dataOffset = 0,
      data = new Uint8Array(sumFrameByteLengths(frames));

    for (i = 0; i < frames.length; i++) {
      currentFrame = frames[i];

      data.set(currentFrame.data, dataOffset);
      dataOffset += currentFrame.data.byteLength;
    }
    return data;
  };
};

AudioSegmentStream.prototype = new Stream();

module.exports = AudioSegmentStream;