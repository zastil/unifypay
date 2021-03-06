'use strict';

angular.module('copayApp.controllers').controller('confirmController', function ($rootScope, $scope, $interval, $filter, $timeout, $ionicScrollDelegate, gettextCatalog, walletService, platformInfo, lodash, configService, $stateParams, $window, $state, $log, profileService, bitcore, bitcoreCash, txFormatService, ongoingProcess, $ionicModal, popupService, $ionicHistory, $ionicConfig, payproService, feeService, bwcError, txConfirmNotification, externalLinkService) {

  var countDown = null;
  var CONFIRM_LIMIT_USD = 20;
  var FEE_TOO_HIGH_LIMIT_PER = 15;

  var tx = {};

  // Config Related values
  var config = configService.getSync();
  var walletConfig = config.wallet;
  var unitToSatoshi = walletConfig.settings.unitToSatoshi;
  var unitDecimals = walletConfig.settings.unitDecimals;
  var satToUnit = 1 / unitToSatoshi;
  var configFeeLevel = walletConfig.settings.feeLevel ? walletConfig.settings.feeLevel : 'normal';


  // Platform info
  var isChromeApp = platformInfo.isChromeApp;
  var isCordova = platformInfo.isCordova;
  var isWindowsPhoneApp = platformInfo.isCordova && platformInfo.isWP;

  var usingCustomFee = false;
  var usingMerchantFee = false;

  function refresh() {
    $timeout(function () {
      $scope.$apply();
    }, 10);
  }

  $scope.openSupport = function () {
    var url = 'https://support.bitpay.com/hc/en-us/articles/115005936786';
    externalLinkService.open(url);
  };

  $scope.showWalletSelector = function () {
    $scope.walletSelector = true;
    refresh();
  };

  $scope.$on("$ionicView.beforeLeave", function (event, data) {
    $ionicConfig.views.swipeBackEnabled(true);
  });

  $scope.$on("$ionicView.enter", function (event, data) {
    $ionicConfig.views.swipeBackEnabled(false);
  });


  function exitWithError(err) {
    $log.info('Error setting wallet selector:' + err);
    popupService.showAlert(gettextCatalog.getString(), bwcError.msg(err), function () {
      $ionicHistory.nextViewOptions({
        disableAnimate: true,
        historyRoot: true
      });
      $ionicHistory.clearHistory();
      $state.go('tabs.send');
    });
  };

  function setNoWallet(msg, criticalError) {
    $scope.wallet = null;
    $scope.noWalletMessage = msg;
    $scope.criticalError = criticalError;
    $log.warn('Not ready to make the payment:' + msg);
    $timeout(function () {
      $scope.$apply();
    });
  };

  $scope.$on("$ionicView.beforeEnter", function (event, data) {

    function setWalletSelector(coin, network, minAmount, cb) {

      // no min amount? (sendMax) => look for no empty wallets
      minAmount = minAmount || 1;

      $scope.wallets = profileService.getWallets({
        onlyComplete: true,
        network: network,
        coin: coin
      });

      if (!$scope.wallets || !$scope.wallets.length) {
        setNoWallet(gettextCatalog.getString('No wallets available'), true);
        return cb();
      }

      var filteredWallets = [];
      var index = 0;
      var walletsUpdated = 0;

      lodash.each($scope.wallets, function (w) {
        walletService.getStatus(w, {}, function (err, status) {
          if (err || !status) {
            $log.error(err);
          } else {
            walletsUpdated++;
            w.status = status;

            if (!status.availableBalanceSat)
              $log.debug('No balance available in: ' + w.name);

            if (status.availableBalanceSat > minAmount) {
              filteredWallets.push(w);
            }
          }

          if (++index == $scope.wallets.length) {
            if (!walletsUpdated)
              return cb('Could not update any wallet');

            if (lodash.isEmpty(filteredWallets)) {
              setNoWallet(gettextCatalog.getString('Insufficient funds'), true);
            }
            $scope.wallets = lodash.clone(filteredWallets);
            return cb();
          }
        });
      });
    };

    // Setup $scope

    var B = data.stateParams.coin == 'bch' ? bitcoreCash : bitcore;
    var networkName;
    try {
      networkName = (new B.Address(data.stateParams.toAddress)).network.name;
    } catch (e) {
      var message = gettextCatalog.getString('Copay only supports Unifycoin Cash using new version numbers addresses');
      var backText = gettextCatalog.getString('Go back');
      var learnText = gettextCatalog.getString('Learn more');
      popupService.showConfirm(null, message, backText, learnText, function (back) {
        $ionicHistory.nextViewOptions({
          disableAnimate: true,
          historyRoot: true
        });
        $state.go('tabs.send').then(function () {
          $ionicHistory.clearHistory();
          if (!back) {
            var url = 'https://support.bitpay.com/hc/en-us/articles/115004671663';
            externalLinkService.open(url);
          }
        });
      });
      return;
    }

    // Grab stateParams
    tx = {
      toAmount: parseInt(data.stateParams.toAmount),
      sendMax: data.stateParams.useSendMax == 'true' ? true : false,
      toAddress: data.stateParams.toAddress,
      description: data.stateParams.description,
      paypro: data.stateParams.paypro,

      spendUnconfirmed: walletConfig.spendUnconfirmed,

      // Vanity tx info (not in the real tx)
      recipientType: data.stateParams.recipientType || null,
      toName: data.stateParams.toName,
      toEmail: data.stateParams.toEmail,
      toColor: data.stateParams.toColor,
      network: networkName,
      coin: data.stateParams.coin,
      txp: {},
    };
    tx.origToAddress = tx.toAddress;

    if (data.stateParams.requiredFeeRate) {
      usingMerchantFee = true;
      tx.feeRate = data.stateParams.requiredFeeRate;
    } else {
      tx.feeLevel = (tx.coin && tx.coin == 'bch') ? 'normal ' : configFeeLevel;
    }

    if (tx.coin && tx.coin == 'bch') {
      // Use legacy address
      tx.toAddress = new bitcoreCash.Address(tx.toAddress).toString();
    };

    // Other Scope vars
    $scope.isCordova = isCordova;
    $scope.isWindowsPhoneApp = isWindowsPhoneApp;
    $scope.showAddress = false;

    $scope.walletSelectorTitle = gettextCatalog.getString('Send from');

    setWalletSelector(tx.coin, tx.network, tx.toAmount, function (err) {
      if (err) {
        return exitWithError('Could not update wallets');
      }

      if ($scope.wallets.length > 1) {
        $scope.showWalletSelector();
      } else if ($scope.wallets.length) {
        setWallet($scope.wallets[0], tx);
      }
    });

  });


  function getSendMaxInfo(tx, wallet, cb) {
    if (!tx.sendMax) return cb();

    //ongoingProcess.set('retrievingInputs', true);
    walletService.getSendMaxInfo(wallet, {
      feePerKb: tx.feeRate,
      excludeUnconfirmedUtxos: !tx.spendUnconfirmed,
      returnInputs: true,
    }, cb);
  };


  function getTxp(tx, wallet, dryRun, cb) {

    // ToDo: use a credential's (or fc's) function for this
    if (tx.description && !wallet.credentials.sharedEncryptingKey) {
      var msg = gettextCatalog.getString('Could not add message to imported wallet without shared encrypting key');
      $log.warn(msg);
      return setSendError(msg);
    }

    if (tx.toAmount > Number.MAX_SAFE_INTEGER) {
      var msg = gettextCatalog.getString('Amount too big');
      $log.warn(msg);
      return setSendError(msg);
    }

    var txp = {};

    txp.outputs = [{
      'toAddress': tx.toAddress,
      'amount': tx.toAmount,
      'message': tx.description
    }];

    if (tx.sendMaxInfo) {
      txp.inputs = tx.sendMaxInfo.inputs;
      txp.fee = tx.sendMaxInfo.fee;
    } else {
      if (usingCustomFee || usingMerchantFee) {
        txp.feePerKb = tx.feeRate;
      } else txp.feeLevel = tx.feeLevel;
    }

    txp.message = tx.description;

    if (tx.paypro) {
      txp.payProUrl = tx.paypro.url;
    }
    txp.excludeUnconfirmedUtxos = !tx.spendUnconfirmed;
    txp.dryRun = dryRun;
    walletService.createTx(wallet, txp, function (err, ctxp) {
      if (err) {
        setSendError(err);
        return cb(err);
      }
      return cb(null, ctxp);
    });
  };

  function updateTx(tx, wallet, opts, cb) {
    ongoingProcess.set('calculatingFee', true);

    if (opts.clearCache) {
      tx.txp = {};
    }

    $scope.tx = tx;

    function updateAmount() {
      if (!tx.toAmount) return;

      // Amount
      tx.amountStr = txFormatService.formatAmountStr(wallet.coin, tx.toAmount);
      tx.amountValueStr = tx.amountStr.split(' ')[0];
      tx.amountUnitStr = tx.amountStr.split(' ')[1];
      txFormatService.formatAlternativeStr(wallet.coin, tx.toAmount, function (v) {
        tx.alternativeAmountStr = v;
      });
    }

    updateAmount();
    refresh();

    // End of quick refresh, before wallet is selected.
    if (!wallet) {
      ongoingProcess.set('calculatingFee', false);
      return cb();
    }

    var maxAllowedMerchantFee = {
      btc: 'urgent',
      bch: 'normal',
    };

    feeService.getFeeRate(wallet.coin, tx.network, usingMerchantFee ? maxAllowedMerchantFee[wallet.coin] : tx.feeLevel, function (err, feeRate) {
      if (err) {
        $log.warn(err);
        ongoingProcess.set('calculatingFee', false);
        return cb(err);
      }

      var msg;
      if (usingCustomFee) {
        msg = gettextCatalog.getString('Custom');
        tx.feeLevelName = msg;
      } else if (usingMerchantFee) {

        var maxAllowedfee = feeRate * 2;
        $log.info('Using Merchant Fee:' + tx.feeRate + ' vs. referent level:' + maxAllowedfee);
        if (tx.network != 'testnet' && tx.feeRate > maxAllowedfee) {
          ongoingProcess.set('calculatingFee', false);
          setNoWallet(gettextCatalog.getString('Merchant fee too high. Payment rejected'), true);
          return cb('fee_too_high');
        }

        msg = gettextCatalog.getString('Suggested by Merchant');
        tx.feeLevelName = msg;
      } else {
        tx.feeLevelName = feeService.feeOpts[tx.feeLevel];
        tx.feeRate = feeRate;
      }
      getSendMaxInfo(lodash.clone(tx), wallet, function (err, sendMaxInfo) {
        if (err) {
          ongoingProcess.set('calculatingFee', false);
          var msg = gettextCatalog.getString('Error getting SendMax information');
          return setSendError(msg);
        }

        if (sendMaxInfo) {

          // $log.debug('Send max info', sendMaxInfo); // by hms
          if(sendMaxInfo.fee < sendMaxInfo.feePerKb){
            sendMaxInfo.amount += sendMaxInfo.fee;
            sendMaxInfo.fee = sendMaxInfo.feePerKb;
            sendMaxInfo.amount -= sendMaxInfo.fee;
          }
          // console.log('Send max info', sendMaxInfo);

          if (tx.sendMax && sendMaxInfo.amount == 0) {
            ongoingProcess.set('calculatingFee', false);
            setNoWallet(gettextCatalog.getString('Insufficient funds'));
            popupService.showAlert(gettextCatalog.getString('Error'), gettextCatalog.getString('Not enough funds for fee'));
            return cb('no_funds');
          }

          tx.sendMaxInfo = sendMaxInfo;
          tx.toAmount = tx.sendMaxInfo.amount;
          updateAmount();
          ongoingProcess.set('calculatingFee', false);
          $timeout(function () {
            showSendMaxWarning(wallet, sendMaxInfo);
          }, 200);
        }


        // txp already generated for this wallet?
        if (tx.txp[wallet.id]) {
          ongoingProcess.set('calculatingFee', false);
          refresh();
          return cb();
        }
        getTxp(lodash.clone(tx), wallet, opts.dryRun, function (err, txp) {
          ongoingProcess.set('calculatingFee', false);
          if (err) {
            if (err.message == 'Insufficient funds') {
              setNoWallet(gettextCatalog.getString('Insufficient funds'));
              popupService.showAlert(gettextCatalog.getString('Error'), gettextCatalog.getString('Not enough funds for fee'));
              return cb('no_funds');
            } else
              return cb(err);
          }

          txp.feeStr = txFormatService.formatAmountStr(wallet.coin, txp.fee);
          txFormatService.formatAlternativeStr(wallet.coin, txp.fee, function (v) {
            txp.alternativeFeeStr = v;
          });

          var per = (txp.fee / (txp.amount + txp.fee) * 100);
          txp.feeRatePerStr = per.toFixed(2) + '%';
          txp.feeTooHigh = per > FEE_TOO_HIGH_LIMIT_PER;

          if (txp.feeTooHigh) {
            $ionicModal.fromTemplateUrl('views/modals/fee-warning.html', {
              scope: $scope
            }).then(function (modal) {
              $scope.feeWarningModal = modal;
              $scope.feeWarningModal.show();
            });

            $scope.close = function () {
              $scope.feeWarningModal.hide();
            };
          }

          tx.txp[wallet.id] = txp;
          $log.debug('Confirm. TX Fully Updated for wallet:' + wallet.id, tx);
          refresh();

          return cb();
        });
      });
    });
  }

  function useSelectedWallet() {

    if (!$scope.useSendMax) {
      showAmount(tx.toAmount);
    }

    $scope.onWalletSelect($scope.wallet);
  }

  function setButtonText(isMultisig, isPayPro) {

    if (isPayPro) {
      if (isCordova && !isWindowsPhoneApp) {
        $scope.buttonText = gettextCatalog.getString('Slide to pay');
      } else {
        $scope.buttonText = gettextCatalog.getString('Click to pay');
      }
    } else if (isMultisig) {
      if (isCordova && !isWindowsPhoneApp) {
        $scope.buttonText = gettextCatalog.getString('Slide to accept');
      } else {
        $scope.buttonText = gettextCatalog.getString('Click to accept');
      }
    } else {
      if (isCordova && !isWindowsPhoneApp) {
        $scope.buttonText = gettextCatalog.getString('Slide to send');
      } else {
        $scope.buttonText = gettextCatalog.getString('Click to send');
      }
    }
  };


  $scope.toggleAddress = function () {
    $scope.showAddress = !$scope.showAddress;
  };


  function showSendMaxWarning(wallet, sendMaxInfo) {

    function verifyExcludedUtxos() {
      var warningMsg = [];
      if (sendMaxInfo.utxosBelowFee > 0) {
        warningMsg.push(gettextCatalog.getString("A total of {{amountBelowFeeStr}} were excluded. These funds come from UTXOs smaller than the network fee provided.", {
          amountBelowFeeStr: txFormatService.formatAmountStr(wallet.coin, sendMaxInfo.amountBelowFee)
        }));
      }

      if (sendMaxInfo.utxosAboveMaxSize > 0) {
        warningMsg.push(gettextCatalog.getString("A total of {{amountAboveMaxSizeStr}} were excluded. The maximum size allowed for a transaction was exceeded.", {
          amountAboveMaxSizeStr: txFormatService.formatAmountStr(wallet.coin, sendMaxInfo.amountAboveMaxSize)
        }));
      }
      return warningMsg.join('\n');
    };

    var msg = gettextCatalog.getString("{{fee}} will be deducted for unifycoin networking fees.", {
      fee: txFormatService.formatAmountStr(wallet.coin, sendMaxInfo.fee)
    });
    var warningMsg = verifyExcludedUtxos();

    if (!lodash.isEmpty(warningMsg))
      msg += '\n' + warningMsg;

    popupService.showAlert(null, msg, function () { });
  };

  $scope.onWalletSelect = function (wallet) {
    setWallet(wallet, tx);
  };

  $scope.showDescriptionPopup = function (tx) {
    var message = gettextCatalog.getString('Add description');
    var opts = {
      defaultText: tx.description
    };

    popupService.showPrompt(null, message, opts, function (res) {
      if (typeof res != 'undefined') tx.description = res;
      $timeout(function () {
        $scope.$apply();
      });
    });
  };

  function _paymentTimeControl(expirationTime) {
    $scope.paymentExpired = false;
    setExpirationTime();

    countDown = $interval(function () {
      setExpirationTime();
    }, 1000);

    function setExpirationTime() {
      var now = Math.floor(Date.now() / 1000);

      if (now > expirationTime) {
        setExpiredValues();
        return;
      }

      var totalSecs = expirationTime - now;
      var m = Math.floor(totalSecs / 60);
      var s = totalSecs % 60;
      $scope.remainingTimeStr = ('0' + m).slice(-2) + ":" + ('0' + s).slice(-2);
    };

    function setExpiredValues() {
      $scope.paymentExpired = true;
      $scope.remainingTimeStr = gettextCatalog.getString('Expired');
      if (countDown) $interval.cancel(countDown);
      $timeout(function () {
        $scope.$apply();
      });
    };
  };

  /* sets a wallet on the UI, creates a TXPs for that wallet */

  function setWallet(wallet, tx) {

    $scope.wallet = wallet;

    // If select another wallet
    tx.coin = wallet.coin;

    if (usingCustomFee || usingMerchantFee) {
    } else {
      tx.feeLevel = wallet.coin == 'bch' ? 'normal' : configFeeLevel;
    }
    setButtonText(wallet.credentials.m > 1, !!tx.paypro);

    if (tx.paypro)
      _paymentTimeControl(tx.paypro.expires);

    updateTx(tx, wallet, {
      dryRun: true
    }, function (err) {
      $timeout(function () {
        $ionicScrollDelegate.resize();
        $scope.$apply();
      }, 10);

    });

  };

  var setSendError = function (msg) {
    $scope.sendStatus = '';
    $timeout(function () {
      $scope.$apply();
    });
    popupService.showAlert(gettextCatalog.getString('Error at confirm'), bwcError.msg(msg));
  };

  $scope.openPPModal = function () {
    $ionicModal.fromTemplateUrl('views/modals/paypro.html', {
      scope: $scope
    }).then(function (modal) {
      $scope.payproModal = modal;
      $scope.payproModal.show();
    });
  };

  $scope.cancel = function () {
    $scope.payproModal.hide();
  };

  $scope.approve = function (tx, wallet, onSendStatusChange) {

    if (!tx || !wallet) return;

    if ($scope.paymentExpired) {
      popupService.showAlert(null, gettextCatalog.getString('This unifycoin payment request has expired.'));
      $scope.sendStatus = '';
      $timeout(function () {
        $scope.$apply();
      });
      return;
    }

    ongoingProcess.set('creatingTx', true, onSendStatusChange);
    getTxp(lodash.clone(tx), wallet, false, function (err, txp) {
      ongoingProcess.set('creatingTx', false, onSendStatusChange);
      if (err) return;

      // confirm txs for more that 20usd, if not spending/touchid is enabled
      function confirmTx(cb) {
        if (walletService.isEncrypted(wallet))
          return cb();

        var amountUsd = parseFloat(txFormatService.formatToUSD(wallet.coin, txp.amount));
        if (amountUsd <= CONFIRM_LIMIT_USD)
          return cb();

        var message = gettextCatalog.getString('Sending {{amountStr}} from your {{name}} wallet', {
          amountStr: tx.amountStr,
          name: wallet.name
        });
        var okText = gettextCatalog.getString('Confirm');
        var cancelText = gettextCatalog.getString('Cancel');
        popupService.showConfirm(null, message, okText, cancelText, function (ok) {
          return cb(!ok);
        });
      };

      function publishAndSign() {
        if (!wallet.canSign() && !wallet.isPrivKeyExternal()) {
          $log.info('No signing proposal: No private key');

          return walletService.onlyPublish(wallet, txp, function (err) {
            if (err) setSendError(err);
          }, onSendStatusChange);
        }

        walletService.publishAndSign(wallet, txp, function (err, txp) {
          if (err) return setSendError(err);
          if (config.confirmedTxsNotifications && config.confirmedTxsNotifications.enabled) {
            txConfirmNotification.subscribe(wallet, {
              txid: txp.txid
            });
          }
        }, onSendStatusChange);
      };

      confirmTx(function (nok) {
        if (nok) {
          $scope.sendStatus = '';
          $timeout(function () {
            $scope.$apply();
          });
          return;
        }
        publishAndSign();
      });
    });
  };

  function statusChangeHandler(processName, showName, isOn) {
    $log.debug('statusChangeHandler: ', processName, showName, isOn);
    if (
      (
        processName === 'broadcastingTx' ||
        ((processName === 'signingTx') && $scope.wallet.m > 1) ||
        (processName == 'sendingTx' && !$scope.wallet.canSign() && !$scope.wallet.isPrivKeyExternal())
      ) && !isOn) {
      $scope.sendStatus = 'success';
      $timeout(function () {
        $scope.$digest();
      }, 100);
    } else if (showName) {
      $scope.sendStatus = showName;
    }
  };

  $scope.statusChangeHandler = statusChangeHandler;

  $scope.onSuccessConfirm = function () {
    $scope.sendStatus = '';
    $ionicHistory.nextViewOptions({
      disableAnimate: true,
      historyRoot: true
    });
    $state.go('tabs.send').then(function () {
      $ionicHistory.clearHistory();
      $state.transitionTo('tabs.home');
    });
  };

  $scope.chooseFeeLevel = function (tx, wallet) {

    if (wallet.coin == 'bch') return;
    if (usingMerchantFee) return;       // ToDo: should we allow overwride?

    var scope = $rootScope.$new(true);
    scope.network = tx.network;
    scope.feeLevel = tx.feeLevel;
    scope.noSave = true;
    scope.coin = wallet.coin;

    if (usingCustomFee) {
      scope.customFeePerKB = tx.feeRate;
      scope.feePerSatByte = tx.feeRate / 1000;
    }

    $ionicModal.fromTemplateUrl('views/modals/chooseFeeLevel.html', {
      scope: scope,
      backdropClickToClose: false,
      hardwareBackButtonClose: false
    }).then(function (modal) {
      scope.chooseFeeLevelModal = modal;
      scope.openModal();
    });
    scope.openModal = function () {
      scope.chooseFeeLevelModal.show();
    };

    scope.hideModal = function (newFeeLevel, customFeePerKB) {
      scope.chooseFeeLevelModal.hide();
      $log.debug('New fee level choosen:' + newFeeLevel + ' was:' + tx.feeLevel);

      usingCustomFee = newFeeLevel == 'custom' ? true : false;

      if (tx.feeLevel == newFeeLevel && !usingCustomFee) return;

      tx.feeLevel = newFeeLevel;
      if (usingCustomFee) tx.feeRate = parseInt(customFeePerKB);

      updateTx(tx, wallet, {
        clearCache: true,
        dryRun: true
      }, function () {
      });
    };
  };

});
