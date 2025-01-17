import * as moment from 'moment';

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';

import { first, startWith, shareReplay, takeUntil, switchMap } from 'rxjs/operators';
import { Observable, Subject, combineLatest } from 'rxjs';

import {
  Devices,
  JanusRole,
  PublishState,
  Publisher,
  RemoteFeed,
  RemoteFeedState,
  RoomInfo,
  RoomInfoState,
  IceServer,
} from '../../models/janus.models';

import { VideoRoomComponent } from '../../models/video-room-wrapper.models';

import { JanusStore } from '../../store/janus.store';
import { JanusErrors, PublishOwnFeedEvent, RequestSubstreamEvent, AttachRemoteFeedEvent } from '../../models';
import { WebrtcService } from '../../services/janus.service';

/**
 * Janus videoroom component. This is a high level component to easily embed a janus videoroom in any angular webapp.
 * There are many options that can be set through Inputs. However, you can get started with the minimal example below.
 * Refer to the {@link https://janus.conf.meetecho.com/docs/videoroom.html|Janus Videoroom Docs} for deploying your own
 * Janus media server.
 * @example
 * <janus-videoroom
 *              [roomId]='1234'
 *              [wsUrl]='wss://janus.conf.meetecho.com/ws'
 * >
 * </janus-videoroom>
 *
 */
@Component({
  selector: 'janus-videoroom',
  templateUrl: './janus-videoroom.component.html',
  styleUrls: ['./janus-videoroom.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [JanusStore],
})
export class JanusVideoroomComponent implements OnInit, OnDestroy, OnChanges {

  /**
   * *Required* Janus room id. Can be either a string or a number. This must match server configuration.
   */
  @Input()
  roomId: string | number;

  /**
   * URL for the websocket interface of the Janus server. At least one of wsUrl or httpUrl must be specified.
   *
   * Example: `wss://janus.conf.meetecho.com/ws`
   */
  @Input()
  wsUrl: string;

  /**
   * URL for the http(s) interface of the Janus server. At least one of wsUrl or httpUrl must be specified.
   *
   * Example: `https://janus.conf.meetecho.com/janus`
   */
  @Input()
  httpUrl: string;

  /**
   * PIN for joining room. Must be specified if `pin_required` is true for the requested roomId.
   */
  @Input()
  pin?: string;

  /**
   * Display name for the user in the videoroom
   */
  @Input()
  userName = 'janus user';

  /**
   * Role for the user in the videoroom.
   *
   * Users can either be publishers or subscribers. Publishers will publish their video and audio to the room.
   * Subscribers will see/hear all publishers, but won't broadcast anything.
   */
  @Input()
  role: JanusRole = JanusRole.publisher;

  /**
   * Numeric or string Id of publisher. Type must match server configuration. If not provided,
   * janus server will automatically assign an ID to the user.
   */
  @Input()
  userId?: string;

  /**
   * Input/output devices to use. If not provided, will use the default system devices
   */
  @Input()
  devices?: Devices;

  /**
   * STUN/TURN servers to use for the connection. These are passed directly to `RTCPeerConnection`
   * Refer to the {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCIceServer|MDN Docs} for details on the format.
   * The component will use a public STUN server if nothing is specified here. However, it's highly recommended that the user
   * deploy and use their own STUN/TURN server(s) for better reliability.
   */
  @Input()
  iceServers: IceServer[] = [{urls: 'stun:stun2.l.google.com:19302'}];

  /**
   * Component to use for implementing the video room
   */
  @Input()
  component?: VideoRoomComponent;

  /**
   * When set to true, the user's audio is muted.
   */
  @Input()
  set isMuted(muted: boolean) {
    this.muted = muted;
    this._setMuted(muted);
  }

  /**
   * @ignore
   */
  get isMuted(): boolean { return this.muted; }

  /**
   * Emits errors encountered. These errors are fatal.
   */
  @Output()
  janusError = new EventEmitter<{ code: number, message: string }>();

  /**
   * Emits list of current publishers whenever there is a change to the publisher list
   */
  @Output()
  publishers = new EventEmitter<Publisher[]>();

  /* Emit any changes in the roomInfo */
  @Output()
  roomInfo = new EventEmitter<RoomInfo>();

  /** @internal */
  roomInfo$: Observable<RoomInfo>;
  /** @internal */
  remoteFeeds$: Observable<RemoteFeed[]>;

  private muted = false;
  private destroy$ = new Subject();
  private janusServerUrl: string;

  constructor(
    private readonly janusStore: JanusStore,
    private webrtc: WebrtcService,
  ) { }

  async ngOnInit(): Promise<void> {
    // Initialize variables and load the room/user

    this.janusServerUrl = this.wsUrl ? this.wsUrl : this.httpUrl;

    this.remoteFeeds$ = this.janusStore.remoteFeeds$.pipe(shareReplay(1));

    this.roomInfo$ = this.janusStore.roomInfo$.pipe(
      shareReplay(1)
    );
    
    this.roomInfo$.subscribe(_roomInfo => {
      this.roomInfo.emit(_roomInfo)
    })

    // @ts-ignore
    if (window.Cypress) {
      // @ts-ignore
      window.janusStore = this.janusStore;
    }

    // This ensures that the user has already granted all permissions before we
    // start setting up the videoroom. Otherwise there are a lot of weird race
    // conditions to consider. I don't love this because it doesn't handle the
    // situation where a custom videoroom doesn't require permissions for any
    // capture devices. However, that's probably not a common use case.
    if (!this.devices) {
      this.devices = await this.webrtc.getDefaultDevices();
    }
    const stream = await this.webrtc.getUserMedia('', '');
    this.webrtc.clearMediaStream(stream);
    this.setupJanusRoom();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngOnChanges(changes): void {
    // For some changes, we refresh the entire session from scratch

    const resetKeys = [
      'roomId',
      'wsUrl',
      'httpUrl',
      'iceServers',
      'pin',
      'role',
      'userName',
      'userId',
      'component',
    ];

    for (const key of resetKeys) {
      if (
        key in changes
        && !changes[key].firstChange
      ) {
        this.janusServerUrl = this.wsUrl ? this.wsUrl : this.httpUrl;
        this.janusStore.reset(this.iceServers);
        break;
      }
    }
  }

  /** @internal */
  _setMuted(muted: boolean): void {
    this.janusStore.setMute(muted);
  }

  /** @internal */
  emitRemoteFeeds(remoteFeeds: RemoteFeed[]): void {
    const publishers: Publisher[] = remoteFeeds.filter((feed) => feed.state === RemoteFeedState.ready);
    this.publishers.emit(publishers);
  }

  /** @internal */
  setupJanusRoom(): void {
    // Setup comms with janus server

    this.janusStore.initialize(this.iceServers);

    this.janusStore.state$.pipe(
      takeUntil(this.destroy$),
    ).subscribe(({roomInfo, remoteFeeds}) => {

      const pin = this.pin ? this.pin : null;
      const remoteFeedsArray = Object.keys(remoteFeeds).map(id => remoteFeeds[id]);
      if (roomInfo.muted !== this.muted && roomInfo.publishState === PublishState.publishing) {
        this._setMuted(this.muted);
      }
      if (roomInfo.publishState === PublishState.error) {
        const message = JanusErrors[roomInfo.errorCode].message;
        this.janusError.emit({code: roomInfo.errorCode, message});
      }

      this.emitRemoteFeeds(remoteFeedsArray);

      switch (roomInfo.state) {
        case RoomInfoState.initialized: {
          this.janusStore.attachVideoRoom(this.janusServerUrl);
          break;
        }
        case RoomInfoState.attached: {
          this.janusStore.register({
            name: this.userName,
            userId: this.userId,
            roomId: this.roomId,
            pin,
          });
          break;
        }
        case RoomInfoState.attach_failed: {
          if (this.janusServerUrl !== this.httpUrl) {
            this.janusServerUrl = this.httpUrl;
            setTimeout(() => {
              this.janusStore.attachVideoRoom(this.janusServerUrl);
            }, 100);
          } else {
            this.janusError.emit({code: 9999, message: 'Unable to connect to media server'});
          }
          break;
        }
      }
    });
  }

  /** @internal */
  onPublishOwnFeed(event: PublishOwnFeedEvent): void {
    this.janusStore.publishOwnFeed(event);
  }

  /** @internal */
  onRequestSubstream(event: RequestSubstreamEvent): void {
    this.janusStore.requestSubstream(event);
  }

  /** @internal */
  onAttachRemoteFeed(event: AttachRemoteFeedEvent): void {
    // Attach remote feeds

    const pin = this.pin ? this.pin : null;
    const { feed, roomInfo } = event;
    this.janusStore.attachRemoteFeed({
      feed,
      roomInfo,
      pin,
    });
  }
}
