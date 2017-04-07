import {AccessPoint, AwsConfig, Ignore, Pair, RegExpMatcher, Trial} from '../models/models';
import {AwsService} from '../services/aws-service';
import {Component, Input, OnChanges, OnInit, Optional, Output, SimpleChanges, ViewChild} from '@angular/core';
import * as CodeMirror from 'codemirror';
import {MdDialogRef, MdTabChangeEvent} from '@angular/material';
import {IOption} from 'ng-select';
import {Hotkey, HotkeysService} from 'angular2-hotkeys';
import {LocalDataSource} from 'ng2-smart-table';
import * as _ from 'lodash';


interface RowData {
    key: string;
    value: string;
}

function createConfig(one: string, other: string): CodeMirror.MergeView.MergeViewEditorConfiguration {
    return {
        value: other,
        orig: undefined,
        origLeft: one,
        lineNumbers: true,
        lineWrapping: true,
        viewportMargin: 10,
        collapseIdentical: 30,
        readOnly: true
    };
}

@Component({
    templateUrl: './detail-dialog.component.html',
    styleUrls: [
        './detail-dialog.css'
    ],
    providers: [
        AwsService
    ]
})
export class DetailDialogComponent implements OnInit {
    @Input() reportKey: string;
    @Input() oneAccessPoint: AccessPoint;
    @Input() otherAccessPoint: AccessPoint;
    @Input() trials: Trial[];
    @Input() ignores: Ignore[];
    @Input() awsConfig: AwsConfig;
    @Input() activeTabIndex: string;

    @ViewChild('selector') selector;
    @ViewChild('mergeView') mergeView;

    queryTableSettings: any;
    queryTableSource = new LocalDataSource();
    propertyDiffs: any[];

    activeIndex: string;
    options: IOption[];
    isLoading: boolean;
    errorMessage: string;
    mergeViewConfig: CodeMirror.MergeView.MergeViewEditorConfiguration;
    displayedQueries: {key: string, value: string}[];

    constructor(private service: AwsService,
                @Optional() public dialogRef: MdDialogRef<DetailDialogComponent>,
                private _hotkeysService: HotkeysService) {
        // To prevent from unexpected close
        dialogRef.config = {disableClose: true};

        // XXX: _hotkeysService.remove(Hotkey[]) is not worked (maybe issues)
        _hotkeysService.hotkeys.splice(0).forEach(x => _hotkeysService.remove(x));

        _hotkeysService.add([
            new Hotkey('d', e => {this.changeTab(0); return false; }, null, 'Move `Diff viewer` tab.'),
            new Hotkey('q', e => {this.changeTab(1); return false; }, null, 'Move `Query parameters` tab.'),
            new Hotkey('p', e => {this.changeTab(2); return false; }, null, 'Move `Property diffs` tab.'),
            new Hotkey('f', e => { return false; }, null, 'Find patterns in active editor.'),
            new Hotkey('i', e => {this.mergeView.moveToPreviousDiff(true); return false; }, null, 'Move to next diff.'),
            new Hotkey('j', e => {this.showPreviousTrial(); return false; }, null, 'Show previous trial.'),
            new Hotkey('k', e => {this.mergeView.moveToNextDiff(true); return false; }, null, 'Move to previous diff.'),
            new Hotkey('l', e => {this.showNextTrial(); return false; }, null, 'Show next trial.'),
            new Hotkey('x', e => { return false; }, null, 'Format the text of the active editor pretty.'),
            new Hotkey('w', e => {this.closeDialog(); return false; }, null, 'Close this dialog'),
            new Hotkey('/', e => {this.openSelector(); return false; }, null, 'Open trial list'),
            new Hotkey('?', e => {this.toggleCheatSheet(); return false; }, null, 'Open/Close cheat sheet')
        ]);
    }

    ngOnInit(): void {
        // value is index of trial
        this.options = this.trials.map((t, i) => ({
            label: `${t.seq}. ${t.name} (${t.path})`,
            value: String(i)
        }));

        this.queryTableSettings = {
            columns: {
                key: {title: 'Key'},
                value: {title: 'Value'}
            },
            actions: false,
            pager: {
                display: false
            }
        };
        this.showTrial(this.getActiveTrial());
    }

    toggleCheatSheet(): void {
        this._hotkeysService.cheatSheetToggle.next({});
    }

    closeDialog(): void {
        this.dialogRef.close();
    }

    getActiveTrial(): Trial {
        return this.trials[this.activeIndex];
    }

    showNextTrial(): boolean {
        const index: number = Number(this.activeIndex);
        if (index === this.trials.length - 1) {
            return false;
        }

        this.showTrial(this.trials[index + 1]);
        this.activeIndex = String(index + 1);
    }

    showPreviousTrial(): boolean {
        const index: number = Number(this.activeIndex);
        if (index === 0) {
            return false;
        }

        this.showTrial(this.trials[index - 1]);
        this.activeIndex = String(index - 1);
    }

    openSelector(): void {
        this.selector.open();
    }

    updateValues(pair: Pair<string>): void {
        this.mergeViewConfig = createConfig(pair.one, pair.other);
    }

    showTrial(trial: Trial): void {
        const fetchFile = (file: string) =>
            this.service.fetchDetail(`${this.reportKey}/${file}`, this.awsConfig);

        this.displayedQueries = Object.keys(trial.queries)
            .map(k => ({key: k, value: trial.queries[k].join(', ')}));
        this.queryTableSource.load(this.displayedQueries.map(t => (<RowData>{
            key: t.key,
            value: t.value
        })));

        const added_rows = !trial.diff_keys ? [] : trial.diff_keys.added.map((x: string) => {
            const m: RegExpMatcher = this.findIgnoreAddedRegExpMatcher(x, trial);
            return {
                pattern: x,
                type: 'added',
                ignore: !!m,
                note: m ? m.note : ''
            };
        });
        const changed_rows = !trial.diff_keys ? [] : trial.diff_keys.changed.map((x: string) => {
            const m: RegExpMatcher = this.findIgnoreChangedRegExpMatcher(x, trial);
            return {
                pattern: x,
                type: 'changed',
                ignore: !!m,
                note: m ? m.note : ''
            };
        });
        const removed_rows = !trial.diff_keys ? [] : trial.diff_keys.removed.map((x: string) => {
            const m: RegExpMatcher = this.findIgnoreRemovedRegExpMatcher(x, trial);
            return {
                pattern: x,
                type: 'removed',
                ignore: !!m,
                note: m ? m.note : ''
            };
        });
        this.propertyDiffs = [...added_rows, ...changed_rows, ...removed_rows];

        if (trial.hasResponse()) {
            this.isLoading = true;
            Promise.all([fetchFile(trial.one.file), fetchFile(trial.other.file)])
                .then((rs: string[]) => {
                    this.isLoading = false;
                    this.errorMessage = undefined;
                    this.mergeViewConfig = createConfig(rs[0], rs[1]);
                })
                .catch(err => {
                    this.isLoading = false;
                    this.errorMessage = err;
                });
        } else {
            this.errorMessage = undefined;
            this.mergeViewConfig = createConfig('No file', 'No file');
        }
    }

    changeTab(index: number): void {
        this.activeTabIndex = String(index);
        this.afterChangeTab(index);
    }

    afterChangeTab(index: number): void {
        if (index === 0 && this.mergeView) {
            this.mergeView.updateView();
        }
    }

    getIgnoredPropertyDiffs() {
        return this.propertyDiffs.filter(x => x.ignore);
    }

    getNoticedPropertyDiffs() {
        return this.propertyDiffs.filter(x => !x.ignore);
    }

    private findIgnoreAddedRegExpMatcher(property: string, trial: Trial): RegExpMatcher {
        return _(this.ignores)
            .filter(x => new RegExp(x.path.pattern).test(trial.path))
            .filter(x => x.path.added)
            .map(x => x.path.added)
            .flatten()
            .find(matcher => new RegExp(matcher.pattern).test(property));
    }

    private findIgnoreRemovedRegExpMatcher(property: string, trial: Trial): RegExpMatcher {
        return _(this.ignores)
            .filter(x => new RegExp(x.path.pattern).test(trial.path))
            .filter(x => x.path.removed)
            .map(x => x.path.removed)
            .flatten()
            .find(matcher => new RegExp(matcher.pattern).test(property));
    }

    private findIgnoreChangedRegExpMatcher(property: string, trial: Trial): RegExpMatcher {
        return _(this.ignores)
            .filter(x => new RegExp(x.path.pattern).test(trial.path))
            .filter(x => x.path.changed)
            .map(x => x.path.changed)
            .flatten()
            .find(matcher => new RegExp(matcher.pattern).test(property));
    }

}
