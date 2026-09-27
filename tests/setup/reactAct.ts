/**
 * DOM テストを React の act 環境として扱う。
 *
 * Testing Library は render / click のたびにこのフラグを立てて元に戻すが、
 * 1つのテストの中で画面を開き直すと戻したタイミングに当たり、
 * 「not configured to support act(...)」の警告が出る。テスト実行中は常に立てておく。
 *
 * DOM を使わないテスト（environment: 'node'）には影響しない。
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
