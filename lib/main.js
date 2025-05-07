"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasReviewedState = void 0;
exports.run = run;
const core_1 = require("@actions/core");
const github_1 = require("@actions/github");
const GITHUB_ACTIONS_LOGIN = "github-actions[bot]";
const repoToken = (0, core_1.getInput)("repo-token", { required: true });
const titleRegex = new RegExp((0, core_1.getInput)("title-regex", {
    required: true,
}));
const onFailedRegexFailAction = (0, core_1.getInput)("on-failed-regex-fail-action") === "true";
const onFailedRegexCreateReview = (0, core_1.getInput)("on-failed-regex-create-review") === "true";
const onFailedRegexRequestChanges = (0, core_1.getInput)("on-failed-regex-request-changes") === "true";
const onFailedRegexComment = (0, core_1.getInput)("on-failed-regex-comment");
const onSucceededRegexDismissReviewComment = (0, core_1.getInput)("on-succeeded-regex-dismiss-review-comment");
const onSucceededRegexMinimizeComment = (0, core_1.getInput)("on-succeeded-regex-minimize-comment") === "true";
const onMinimizeCommentReason = (0, core_1.getInput)("on-minimize-comment-reason") || "resolved";
const octokit = (0, github_1.getOctokit)(repoToken);
async function run() {
    const githubContext = github_1.context;
    const pullRequest = githubContext.issue;
    const title = githubContext.payload.pull_request?.title ?? "";
    const comment = onFailedRegexComment.replace("%regex%", titleRegex.source);
    (0, core_1.debug)(`Title Regex: ${titleRegex.source}`);
    (0, core_1.debug)(`Title: ${title}`);
    const titleMatchesRegex = titleRegex.test(title);
    if (!titleMatchesRegex) {
        if (onFailedRegexCreateReview) {
            await createOrUpdateReview(comment, pullRequest);
        }
        if (onFailedRegexFailAction) {
            (0, core_1.setFailed)(comment);
        }
    }
    else {
        if (onFailedRegexCreateReview) {
            await dismissReview(pullRequest);
        }
        if (onSucceededRegexMinimizeComment) {
            (0, core_1.debug)(`Minimizing existing comments on PR #${pullRequest.number} - debug`);
            console.log(`Minimizing existing comments on PR #${pullRequest.number} - log`);
            await minimizeExistingComments(pullRequest);
        }
    }
}
const createOrUpdateReview = async (comment, pullRequest) => {
    const review = await getExistingReview(pullRequest);
    if (review === undefined) {
        await octokit.rest.pulls.createReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            body: comment,
            event: onFailedRegexRequestChanges ? "REQUEST_CHANGES" : "COMMENT",
        });
    }
    else {
        await octokit.rest.pulls.updateReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            review_id: review.id,
            body: comment,
        });
    }
};
const getExistingComments = async (pullRequest) => {
    (0, core_1.debug)(`Getting comments for PR #${pullRequest.number}`);
    const comments = await octokit.rest.issues.listComments({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        issue_number: pullRequest.number,
    });
    return comments.data.filter((comment) => {
        return comment.user !== null && isGitHubActionUser(comment.user.login);
    });
};
const getCommentNodeId = async (commentDatabaseId, pullRequest) => {
    try {
        const { repository } = await octokit.graphql(`
      query GetCommentNodeId($owner: String!, $repo: String!, $prNumber: Int!, $commentDatabaseId: Int!) {
        repository(owner: $owner, name: $repo) {
          issueOrPullRequest(number: $prNumber) {
            ... on Issue {
              comments(first: 1, where: {databaseId: $commentDatabaseId}) {
                nodes {
                  id
                }
              }
            }
            ... on PullRequest {
              comments(first: 1, where: {databaseId: $commentDatabaseId}) {
                nodes {
                  id
                }
              }
            }
          }
        }
      }
    `, {
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            prNumber: pullRequest.number,
            commentDatabaseId: commentDatabaseId,
        });
        const issueOrPR = repository?.issueOrPullRequest;
        if (!issueOrPR)
            return null;
        const comments = issueOrPR.comments.nodes;
        if (comments && comments.length > 0) {
            return comments[0].id;
        }
        return null;
    }
    catch (error) {
        (0, core_1.debug)(`Error fetching comment node ID: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
};
const minimizeExistingComments = async (pullRequest) => {
    (0, core_1.debug)(`Minimizing existing comments on PR #${pullRequest.number}`);
    const comments = await getExistingComments(pullRequest);
    for (const comment of comments) {
        (0, core_1.debug)(`Processing comment with database ID: ${comment.id}`);
        const nodeId = await getCommentNodeId(comment.id, pullRequest);
        if (nodeId) {
            await minimizeComment(nodeId, pullRequest);
        }
        else {
            (0, core_1.debug)(`Could not find node ID for comment ${comment.id}`);
        }
    }
};
const minimizeComment = async (commentNodeId, pullRequest) => {
    try {
        (0, core_1.debug)(`Minimizing comment with node ID: ${commentNodeId}`);
        const { minimizeComment: result } = await octokit.graphql(`
      mutation MinimizeComment($input: MinimizeCommentInput!) {
        minimizeComment(input: $input) {
          minimizedComment {
            isMinimized
            minimizedReason
          }
        }
      }
    `, {
            input: {
                subjectId: commentNodeId,
                classifier: onMinimizeCommentReason,
                clientMutationId: `pr-lint-action-${pullRequest.number}-${Date.now()}`,
            },
        });
        (0, core_1.debug)(`Comment minimized successfully: ${JSON.stringify(result)}`);
    }
    catch (error) {
        (0, core_1.debug)(`Failed to minimize comment: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
            (0, core_1.debug)(`Stack trace: ${error.stack}`);
        }
    }
};
const dismissReview = async (pullRequest) => {
    (0, core_1.debug)(`Trying to get existing review`);
    const review = await getExistingReview(pullRequest);
    if (review === undefined) {
        (0, core_1.debug)("Found no existing review");
        return;
    }
    if (review.state === "COMMENTED") {
        await octokit.rest.pulls.updateReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            review_id: review.id,
            body: onSucceededRegexDismissReviewComment,
        });
        (0, core_1.debug)(`Updated existing review`);
    }
    else {
        await octokit.rest.pulls.dismissReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            review_id: review.id,
            message: onSucceededRegexDismissReviewComment,
        });
        (0, core_1.debug)(`Dismissed existing review`);
    }
};
const getExistingReview = async (pullRequest) => {
    (0, core_1.debug)(`Getting reviews`);
    const reviews = await octokit.rest.pulls.listReviews({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        pull_number: pullRequest.number,
    });
    return reviews.data.find((review) => {
        return (review.user != null &&
            isGitHubActionUser(review.user.login) &&
            (0, exports.hasReviewedState)(review.state));
    });
};
const isGitHubActionUser = (login) => {
    return login === GITHUB_ACTIONS_LOGIN;
};
const hasReviewedState = (state) => {
    return state === "CHANGES_REQUESTED" || state === "COMMENTED";
};
exports.hasReviewedState = hasReviewedState;
