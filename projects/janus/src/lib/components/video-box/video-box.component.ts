import * as moment from 'moment';

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  OnChanges,
  Output,
  ViewChild,
} from '@angular/core';

import { Subject, interval, fromEvent } from 'rxjs';
import { first, takeUntil, debounce } from 'rxjs/operators';

import { RemoteFeed, JanusRole, Devices } from '../../models/janus.models';
import { randomString } from '../../shared';
import { JanusService } from '../../services/janus.service';

import { VideoQualityHelper } from './video-quality-helper';


/** @internal */
@Component({
  selector: 'janus-video-box',
  templateUrl: './video-box.component.html',
  styleUrls: [
    './video-box.component.scss',
    '../../styles/video-styles.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VideoBoxComponent implements OnInit, OnChanges, OnDestroy, AfterViewInit {

  @Input() remoteFeed: RemoteFeed;
  @Input() mode: 'speaker' | 'grid';
  @Input()
  get devices(): Devices {
    return this.localDevices;
  }
  set devices(devices: Devices) {
    this.localDevices = devices;
    this.onDeviceChange(devices);
  }

  @Output()
  maximize = new EventEmitter<RemoteFeed>();

  @Output()
  requestSubstream = new EventEmitter<{feed: RemoteFeed, substreamId: number}>();

  public videoId: string;
  public optionsOpen = false;
  public videoAvailable = false;

  videoQualityHelper: VideoQualityHelper; // public for testing purposes

  private localDevices: Devices;
  private destroy$ = new Subject();

  @ViewChild('videoElement') video: ElementRef;

  constructor(
    private janusService: JanusService
  ) {
    this.videoQualityHelper = new VideoQualityHelper(3);
  }

  ngOnInit(): void {
    // Set my unique id for the video
    this.videoId = 'video-' + this.remoteFeed.id + this.mode;
    this.setupSubscriptions();
  }

  ngAfterViewInit(): void {
    this._attachMediaStream();
    this.setSpeaker(this.devices);
  }

  ngOnChanges(changes): void {
    if ('remoteFeed' in changes) {
      // If there's a change in the remoteFeed, run the video quality monitor task
      const slowLink = false;

      /*  Taking this out of this release. Just not enough time to test it
      if (
        changes.remoteFeed.previousValue
        && changes.remoteFeed.previousValue.slowLink !== changes.remoteFeed.currentValue.slowLink
      ) {
        slowLink = true;
      }
      */

      this.monitorVideoQuality(slowLink);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.video) {
      this.video.nativeElement.pause();
    }
  }

  setupSubscriptions(): void {
    interval(1000).pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      this.monitorVideoQuality(false);
    });
  }

  _attachMediaStream(): void {
    this.janusService.attachMediaStream(this.videoId, this.remoteFeed.streamId);
  }

  private setSpeaker(devices: Devices): void {
    // Given the devices, set the output sound device
    if (
      this.video
      && this.video.nativeElement
      && this.video.nativeElement.setSinkId
      && devices
      && devices.speakerDeviceId
    ) {
      this.video.nativeElement.setSinkId(devices.speakerDeviceId);
    }
  }

  onPlay(): void {
    this.videoAvailable = true;
  }

  monitorVideoQuality(slowLink: boolean): void {
    // Periodic task to monitor the video quality and change substream if necessary

    if (!this.remoteFeed) {
      // If we don't have a remoteFeed, nothing we can do here
      return;
    }

    const currentSubstream = this.remoteFeed.currentSubstream;
    if (this.remoteFeed.numVideoTracks === 0 || slowLink) {
      this.videoQualityHelper.streamError(currentSubstream);
      if (currentSubstream > 0) {
        this.switchSubstream(currentSubstream - 1);
      }
    } else {
      const newSubstream = this.videoQualityHelper.ping(currentSubstream);
      if (newSubstream > currentSubstream) {
        this.videoQualityHelper.streamEnd(currentSubstream);
        this.switchSubstream(newSubstream);
      }
    }
  }

  switchSubstream(substreamId: number): void {
    // Switch the substream if we haven't already requested this substream
    if (this.remoteFeed.requestedSubstream !== substreamId) {
      console.log('switching substream', substreamId, this.videoId);
      this.requestSubstream.emit({feed: this.remoteFeed, substreamId});
    }
  }

  onMaximize(): void {
    this.maximize.emit(this.remoteFeed);
  }

  onDeviceChange(devices: Devices): void {
    this.setSpeaker(devices);
  }
}
