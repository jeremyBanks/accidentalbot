'use strict';

var app = angular.module('AccidentalBotApp', []);
var scope = null;

app.filter('timeAgo', function() {
    return function(date) {
        return moment(date).fromNow();
    }
});

app.controller('AppController', function($scope) {
    scope = $scope;

    // State
    var connection = null;

    scope.titles = [];
    scope.links = [];

    scope.voteFor = function(title, event) {
        event.preventDefault();
        if (title.voted) return;

        title.votes++;
        title.voted = true;

        connection.send(JSON.stringify({operation: 'VOTE', id: title.id}));
    };

    scope.handleLink = function(link, event) {
        event.preventDefault();
        var answer = confirm("Tread carefully; these links aren't checked for safety!\nWould you like to go to the following URL?\n\n" + link.link);
        if (answer) {
            window.location = link.link;
        }
    };

    scope.titleScore = function(title) {
        // Ranks titles so that recently-posted high-scoring posts are near the top.
        var pointsOfRankLostPerDay = 48;
        var maxHoursAgeOfVisibleUnvotedPost = 12;
        return Math.max(0, title.votes + pointsOfRankLostPerDay * (((new Date(title.time) - new Date) / 86400000) + maxHoursAgeOfVisibleUnvotedPost/24));

    };

    function ping() {
        if (connection != null) {
            connection.send(JSON.stringify({operation: 'PING'}));
        }
        scope.$apply(); // re-render Angular templates to update timeAgos.
    }

    connectSocket();

    scope.status = 'connecting';

    setInterval(function() {
        // Ensure the scope is refreshed frequently enough for `fromNow` to
        // respond quickly.
        scope.$apply();
    }, 1500);

	function connectSocket() {
		if (connection == null || connection.readyState == 3) {
			// Connect to the server and await feedback.
            if (window.location.hostname == 'localhost' || window.location.hostname == '') {
                connection = new WebSocket('ws://localhost:5001');
            } else {
	            connection = new WebSocket('ws://thawing-bayou-3232.herokuapp.com:80');
            }

			connection.onopen = function (event) {
                scope.status = 'connected';
                scope.titles = [];
                scope.links = [];
				setInterval(ping, 30000);
			};

			connection.onmessage = function (message) {
                scope.$apply(function() {
                    var packet = JSON.parse(message.data);
                    console.log(JSON.stringify(packet));
                    if (packet.operation == 'REFRESH') {
                        scope.titles = packet.titles;
                        scope.links = packet.links;
                    } else if (packet.operation == 'NEW') {
                        // New title
                        scope.titles.push(packet.title);
                    } else if (packet.operation == 'NEWLINK') {
                        scope.links.push(packet.link);
                    } else if (packet.operation == 'VOTE') {
                        for (var i = 0; i < scope.titles.length; i++) {
                            if (scope.titles[i].id === packet.id) {
                                scope.titles[i].votes = packet.votes;
                            }
                        }
                    } else if (packet.operation == 'PONG') {
                        // NOOP
                    }
                });
			};

			connection.onclose = function (event) {
                scope.status = 'connecting';
				setTimeout(connectSocket, 5000);
                clearInterval(ping);
			};

			connection.onerror = function (error) {
				console.log("Error: " + JSON.stringify(error));
			};
		} else {
			setTimeout(connectSocket, 5000);
		}
	}
});
