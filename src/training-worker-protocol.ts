import type {ParkingBrain} from './parking/session';
import type {ParkingSettings,Lesson} from './parking/model';
import type {DrivingExample,ParkingTrainingReport,ParkingGenerationMetrics} from './parking/training';
import type {TrackSettings,WorldSettings} from './vision/ui/sessions';
import type {CameraTrainingResult} from './vision/browser-training';
import type {WorldTrainingResult} from './vision/world/training';
import type {CohortBudget} from './vision/runtime-budget';
import type {GenerationCheckpoint} from './evolution-checkpoint';
import type {TrackDefinition} from './core';
import type {PreviewState} from './training-preview';
import type {ParkingDonor} from './parking/gene-pool';

export type TrainingControls={visible:boolean;preview:boolean[];rates:number[];budget:CohortBudget};
export type TrainingJob=
 | {kind:'parking';brain:ParkingBrain;settings:ParkingSettings;generations:number;population:number;lessons:Lesson[];seed:number;speed:number;demonstrations?:DrivingExample[]}
 | {kind:'track';settings:TrackSettings;generations:number;population:number;speed:number;maps:string[];tracks:TrackDefinition[]}
 | {kind:'world';settings:WorldSettings;generations:number;population:number;speed:number;crashWeight:number;coach:boolean;retain:boolean;seed:number;failureRetries:number};
export type TrainingReport=ParkingTrainingReport|CameraTrainingResult|WorldTrainingResult|null;
export type WorkerRequest={type:'start';job:TrainingJob;controls:TrainingControls}|{type:'controls';controls:TrainingControls}|{type:'gene-pool';donors:ParkingDonor[]}|{type:'cancel'}|{type:'ack';id:number;error?:string};
export type WorkerReply={type:'log';text:string}|{type:'progress';rows:PreviewState[];generation:number;seed:number}|{type:'parking-metrics';metrics:ParkingGenerationMetrics}|{type:'checkpoint';id:number;checkpoint:GenerationCheckpoint}|{type:'result';report:TrainingReport}|{type:'error';message:string};
